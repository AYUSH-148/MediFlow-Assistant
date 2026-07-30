import { GoogleGenerativeAI, type GenerateContentResponse } from "@google/generative-ai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { redactDocument, redactTriples, storeVault, storeTriplesInNeo4j, getVault } from "@/lib/pii-redaction";
import { GEMINI_MODEL_ID, GOOGLE_SDK_SAFETY_SETTINGS } from "@/lib/gemini";
import { generateDocumentId, generateEmbedding, upsertVectors, pinecone } from "@/utils";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({
  model: GEMINI_MODEL_ID,
  safetySettings: GOOGLE_SDK_SAFETY_SETTINGS,
});

type Triple = { subject: string; predicate: string; object: string };

// Chunk sizing is tuned for the embedding model (mxbai-embed-large-v1, 512-token limit).
// ~1200 chars ≈ well under 512 tokens for dense clinical text, with overlap to preserve
// context across boundaries.
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const EMBED_BATCH_SIZE = 8;

// A PDF is treated as "born-digital" (has a real text layer) only if extraction yields
// enough text. Scanned/photographed PDFs return little or no text and fall back to Gemini OCR.
const MIN_TEXT_LAYER_CHARS = 100;
const MIN_CHARS_PER_PAGE = 20;

const TEXT_ANALYSIS_PROMPT = `Below is the extracted text of a clinical report.
Go over it and identify biomarkers that show slight or large abnormalities, then summarize in about 100 words (you may exceed this for multi-page reports). Include numerical values, key details, and the report title.

Additionally, extract entity relationships as triples in the format {"subject": "Entity A", "predicate": "relationship", "object": "Entity B"}. Focus on medical entities like drugs, conditions, symptoms, and treatments.

Respond ONLY with JSON in this exact shape:
{
  "summary": "Your summary text here",
  "triples": [{"subject": "...", "predicate": "...", "object": "..."}]
}

## Clinical report text:
`;

const VISION_PROMPT = `Attached is a clinical report (image or scanned PDF).

1. Transcribe ALL text content from the report verbatim, including any patient names, dates, contact information, medical record numbers, and other identifying details exactly as they appear. This raw transcription is required for downstream security redaction.
2. Identify biomarkers that show slight or large abnormalities and summarize in about 100 words (you may exceed this for multi-page reports). Include numerical values, key details, and the report title.
3. Extract entity relationships as triples in the format {"subject": "Entity A", "predicate": "relationship", "object": "Entity B"}. Focus on medical entities like drugs, conditions, symptoms, and treatments.

Respond ONLY with JSON in this exact shape:
{
  "transcription": "Full verbatim text of the report",
  "summary": "Your summary text here",
  "triples": [{"subject": "...", "predicate": "...", "object": "..."}]
}

## Response:`;

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const commaIndex = dataUrl.indexOf(",");
  const meta = dataUrl.substring(0, commaIndex);
  const b64 = dataUrl.substring(commaIndex + 1);
  const mimeType = meta.substring(meta.indexOf(":") + 1, meta.indexOf(";"));
  return { mimeType, buffer: Buffer.from(b64, "base64") };
}

function fileToGenerativePart(imageData: string) {
  return {
    inlineData: {
      data: imageData.split(",")[1],
      mimeType: imageData.substring(imageData.indexOf(":") + 1, imageData.lastIndexOf(";")),
    },
  };
}

// Raised when Gemini gives us nothing usable to work with. Carries a developer-facing
// detail; the route turns it into a 422 with a human-readable message.
class ExtractionFailedError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = "ExtractionFailedError";
  }
}

// A blocked or truncated generation comes back as a response with no text rather than
// as an error, so reading straight through to JSON.parse crashed on `undefined` and
// surfaced to the user as an opaque 500. Fail explicitly instead.
function extractResponseText(response: GenerateContentResponse): string {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new ExtractionFailedError(`Gemini blocked the prompt (blockReason=${blockReason})`);
  }

  const candidate = response.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    throw new ExtractionFailedError(
      `Gemini returned no text (finishReason=${candidate?.finishReason ?? "none"})`
    );
  }

  return text;
}

// Gemini often wraps JSON in a ```json ... ``` fence; strip it before parsing.
function parseGeminiJson(raw: string): any {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ExtractionFailedError("Gemini response was not valid JSON");
  }
}

// pdf-parse inserts a "-- N of M --" marker between pages. Left in, it can survive as
// its own near-empty chunk after splitting and gets retrieved as if it were content.
function stripPdfParseArtifacts(text: string): string {
  return text
    .replace(/^--\s*\d+\s*of\s*\d+\s*--\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Extract the text layer of a born-digital PDF. Returns null when the PDF has no usable
// text layer (scanned/image-only), signalling the caller to fall back to Gemini OCR.
async function extractPdfTextLayer(buffer: Buffer): Promise<string | null> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      const text = stripPdfParseArtifacts(result.text ?? "");
      const pageCount = result.total || result.pages?.length || 1;
      if (text.length < MIN_TEXT_LAYER_CHARS || text.length / pageCount < MIN_CHARS_PER_PAGE) {
        return null;
      }
      return text;
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    console.error("PDF text-layer extraction failed, will fall back to OCR:", error);
    return null;
  }
}

async function analyzeText(fullText: string): Promise<{ summary: string; triples: Triple[] }> {
  const generated = await model.generateContent(TEXT_ANALYSIS_PROMPT + fullText);
  const parsed = parseGeminiJson(extractResponseText(generated.response));
  return { summary: parsed.summary ?? "", triples: Array.isArray(parsed.triples) ? parsed.triples : [] };
}

async function transcribeAndAnalyze(
  base64: string
): Promise<{ fullText: string; summary: string; triples: Triple[] }> {
  const generated = await model.generateContent([VISION_PROMPT, fileToGenerativePart(base64)]);
  const parsed = parseGeminiJson(extractResponseText(generated.response));
  return {
    fullText: parsed.transcription ?? parsed.summary ?? "",
    summary: parsed.summary ?? "",
    triples: Array.isArray(parsed.triples) ? parsed.triples : [],
  };
}

async function embedInBatches(chunks: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const batchEmbeddings = await Promise.all(batch.map((chunk) => generateEmbedding(chunk)));
    embeddings.push(...batchEmbeddings);
  }
  return embeddings;
}

export async function POST(req: Request) {
  const { base64 } = await req.json();
  const { mimeType, buffer } = parseDataUrl(base64);

  // ==================== EXTRACTION ====================
  let fullText: string;
  let summary: string;
  let triples: Triple[];

  try {
    if (mimeType === "application/pdf") {
      const textLayer = await extractPdfTextLayer(buffer);
      if (textLayer) {
        console.log("📄 Using PDF text layer for extraction");
        fullText = textLayer;
        ({ summary, triples } = await analyzeText(fullText));
      } else {
        console.log("🖼️ PDF has no usable text layer, falling back to Gemini OCR");
        ({ fullText, summary, triples } = await transcribeAndAnalyze(base64));
      }
    } else {
      console.log("🖼️ Image input, using Gemini OCR");
      ({ fullText, summary, triples } = await transcribeAndAnalyze(base64));
    }
  } catch (error) {
    if (error instanceof ExtractionFailedError) {
      console.error("❌ Extraction failed:", error.detail);
      return new Response(
        JSON.stringify({
          error:
            "We couldn't read this document. Try a clearer scan, or a different report.",
          detail: error.detail,
        }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      );
    }
    throw error;
  }

  if (!fullText.trim()) {
    return new Response(JSON.stringify({ error: "Could not extract any text from the document" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ==================== PII REDACTION ====================
  // Redact the full document text and the summary together so they share one coherent
  // vault (a given name/number maps to the same token in both).
  console.log("🔒 Applying PII redaction to full document...");
  const { redactedTexts, vault } = redactDocument([fullText, summary]);
  const [redactedFullText, redactedSummary] = redactedTexts;
  const piiCount = Object.keys(vault).length;
  console.log(`📊 Redacted ${piiCount} PII entities`);

  // Document identity is derived from the redacted FULL text now (not the summary).
  const documentId = generateDocumentId(redactedFullText);
  console.log("Document ID:", documentId);

  let chunkCount = 0;
  const existingVault = await getVault(documentId);
  if (existingVault) {
    console.log(`✅ Document already exists: ${documentId}. Refreshing TTL and skipping re-ingestion.`);
    await storeVault(documentId, existingVault);
  } else {
    await storeVault(documentId, vault);

    // ==================== CHUNK + EMBED + UPSERT ====================
    try {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: CHUNK_SIZE,
        chunkOverlap: CHUNK_OVERLAP,
      });
      const chunks = await splitter.splitText(redactedFullText);
      chunkCount = chunks.length;
      console.log(`✂️ Split document into ${chunkCount} chunks`);

      const embeddings = await embedInBatches(chunks);
      const vectors = chunks.map((chunk, i) => ({
        id: `${documentId}-chunk-${i}`,
        values: embeddings[i],
        metadata: {
          documentId,
          chunk,
          chunkIndex: i,
          piiCount,
        },
      }));

      await upsertVectors(pinecone, "medic", vectors, "diagnosis2");
      console.log(`✅ Stored ${chunkCount} redacted chunks in Pinecone`);
    } catch (error) {
      console.error("Failed to chunk/embed/store document in Pinecone:", error);
    }
  }

  // ==================== STORE TRIPLES IN NEO4J ====================
  if (triples && Array.isArray(triples) && triples.length > 0) {
    const redactedTriples = redactTriples(triples, vault);
    console.log(`📈 Storing ${redactedTriples.length} redacted triples in Neo4j...`);
    try {
      await storeTriplesInNeo4j(redactedTriples, documentId);
      console.log("✅ Redacted triples stored successfully");
    } catch (error) {
      console.error("Failed to store triples in Neo4j:", error);
    }
  }

  const response = {
    redactedSummary,
    vaultId: documentId,
    piiCount,
    triplesStored: triples ? triples.length : 0,
    chunkCount,
  };

  console.log("✅ Report processed with PII redaction and GraphRAG storage");
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
