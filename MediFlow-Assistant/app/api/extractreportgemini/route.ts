import { generateObject, NoObjectGeneratedError, TypeValidationError } from "ai";
import { z } from "zod";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { redactDocument, redactTriples, storeVault, storeTriplesInNeo4j, getVault } from "@/lib/pii-redaction";
import { geminiModel } from "@/lib/gemini";
import { generateEmbeddings } from "@/lib/embeddings";
import { generateDocumentId, upsertVectors, pinecone } from "@/utils";

export const maxDuration = 60;

// The shape is enforced by Gemini's structured-output mode rather than described in
// the prompt and parsed by hand, so a malformed or renamed field fails loudly here
// instead of silently becoming an empty summary downstream.
const TRIPLE_SCHEMA = z.object({
  subject: z.string().describe("The source medical entity, e.g. a drug or condition"),
  predicate: z.string().describe("The relationship, e.g. treats, causes, interacts with"),
  object: z.string().describe("The target medical entity"),
});

const TEXT_ANALYSIS_SCHEMA = z.object({
  summary: z.string().describe("Summary of the report's abnormal biomarkers, with values"),
  triples: z.array(TRIPLE_SCHEMA).describe("Entity relationships found in the report"),
});

// The newline instruction is load-bearing, not cosmetic. Gemini's structured-output
// mode returns string fields with the line breaks stripped, which runs the report's
// lines together ("...RAHUL MEHTAMRN 884213PHONE..."). The PII rules in
// @/lib/pii-redaction are label-anchored and mostly \b-delimited, so a run-together
// transcription defeats them and identifiers survive into the vault-less output.
// Asking for the line structure explicitly restores it.
const VISION_ANALYSIS_SCHEMA = TEXT_ANALYSIS_SCHEMA.extend({
  transcription: z
    .string()
    .describe(
      "Full verbatim text of the report, including identifiers. Preserve the report's " +
        "original line structure using \\n newline characters between lines."
    ),
});

type Triple = z.infer<typeof TRIPLE_SCHEMA>;

// Chunk sizing is tuned for the embedding model in @/lib/embeddings
// (mxbai-embed-large-v1, 512-token limit). ~1200 chars ≈ well under 512 tokens for
// dense clinical text, with overlap to preserve context across boundaries.
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;

// A PDF is treated as "born-digital" (has a real text layer) only if extraction yields
// enough text. Scanned/photographed PDFs return little or no text and fall back to Gemini OCR.
const MIN_TEXT_LAYER_CHARS = 100;
const MIN_CHARS_PER_PAGE = 20;

// The prompts no longer describe the JSON shape or ask for "JSON only" - the schema
// above does that, and repeating it in the prompt just invites the two to disagree.
const TEXT_ANALYSIS_PROMPT = `Below is the extracted text of a clinical report.
Go over it and identify biomarkers that show slight or large abnormalities, then summarize in about 100 words (you may exceed this for multi-page reports). Include numerical values, key details, and the report title.

Additionally, extract entity relationships as triples. Focus on medical entities like drugs, conditions, symptoms, and treatments.

## Clinical report text:
`;

const VISION_PROMPT = `Attached is a clinical report (image or scanned PDF).

1. Transcribe ALL text content from the report verbatim, including any patient names, dates, contact information, medical record numbers, and other identifying details exactly as they appear. This raw transcription is required for downstream security redaction.
2. Identify biomarkers that show slight or large abnormalities and summarize in about 100 words (you may exceed this for multi-page reports). Include numerical values, key details, and the report title.
3. Extract entity relationships as triples. Focus on medical entities like drugs, conditions, symptoms, and treatments.`;

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const commaIndex = dataUrl.indexOf(",");
  const meta = dataUrl.substring(0, commaIndex);
  const b64 = dataUrl.substring(commaIndex + 1);
  const mimeType = meta.substring(meta.indexOf(":") + 1, meta.indexOf(";"));
  return { mimeType, buffer: Buffer.from(b64, "base64") };
}

// Raised when Gemini gives us nothing usable to work with. Carries a developer-facing
// detail; the route turns it into a 422 with a human-readable message.
class ExtractionFailedError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = "ExtractionFailedError";
  }
}

// generateObject throws when the model produces nothing parseable or something that
// doesn't match the schema - a safety block, a truncated response, or a hallucinated
// shape. Those are all "this document couldn't be read" and belong in a 422. Anything
// else (network, auth, quota) is a real server fault and rethrows as a 500.
function asExtractionFailure(error: unknown): never {
  if (NoObjectGeneratedError.isInstance(error)) {
    throw new ExtractionFailedError(`Gemini returned no usable object: ${error.message}`);
  }
  if (TypeValidationError.isInstance(error)) {
    throw new ExtractionFailedError(`Gemini output did not match the schema: ${error.message}`);
  }
  throw error;
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
  try {
    const { object } = await generateObject({
      model: geminiModel,
      schema: TEXT_ANALYSIS_SCHEMA,
      prompt: TEXT_ANALYSIS_PROMPT + fullText,
    });
    return object;
  } catch (error) {
    asExtractionFailure(error);
  }
}

// Images go as an image part; a scanned PDF goes as a file part with its mime type -
// Gemini reads the PDF itself in that case, which is the no-text-layer fallback.
async function transcribeAndAnalyze(
  mimeType: string,
  buffer: Buffer
): Promise<{ fullText: string; summary: string; triples: Triple[] }> {
  try {
    const { object } = await generateObject({
      model: geminiModel,
      schema: VISION_ANALYSIS_SCHEMA,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            mimeType === "application/pdf"
              ? { type: "file", data: buffer, mimeType }
              : { type: "image", image: buffer, mimeType },
          ],
        },
      ],
    });
    return {
      // Transcription drives redaction and chunking; the summary is a usable fallback
      // if the model returns an empty transcription for an unreadable scan.
      fullText: object.transcription || object.summary,
      summary: object.summary,
      triples: object.triples,
    };
  } catch (error) {
    asExtractionFailure(error);
  }
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
        ({ fullText, summary, triples } = await transcribeAndAnalyze(mimeType, buffer));
      }
    } else {
      console.log("🖼️ Image input, using Gemini OCR");
      ({ fullText, summary, triples } = await transcribeAndAnalyze(mimeType, buffer));
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

      const embeddings = await generateEmbeddings(chunks);
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
