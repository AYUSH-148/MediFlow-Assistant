import { generateObject, NoObjectGeneratedError, TypeValidationError } from "ai";
import { z } from "zod";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { redactDocument, redactTriples, storeVault, storeTriplesInNeo4j, getVault } from "@/lib/pii-redaction";
import { geminiModel, GEMINI_MODEL_ID } from "@/lib/gemini";
import { generateEmbeddings } from "@/lib/embeddings";
import { describePdfFigures, NO_FIGURES, type FigureExtraction } from "@/lib/pdf-figures";
import { generateDocumentId, upsertVectors, pinecone } from "@/utils";
import {
  span,
  setSpanMetadata,
  flushTraces,
  textShape,
  llmMetadata,
  usageMetadata,
} from "@/lib/tracing";

export const maxDuration = 60;

// Enforced by Gemini's structured-output mode rather than described in the prompt and
// parsed by hand, so a malformed or renamed field fails loudly here instead of silently
// becoming an empty summary downstream.
const TRIPLE_SCHEMA = z.object({
  subject: z.string().describe("The source medical entity, e.g. a drug or condition"),
  predicate: z.string().describe("The relationship, e.g. treats, causes, interacts with"),
  object: z.string().describe("The target medical entity"),
});

const TEXT_ANALYSIS_SCHEMA = z.object({
  summary: z.string().describe("Summary of the report's abnormal biomarkers, with values"),
  triples: z.array(TRIPLE_SCHEMA).describe("Entity relationships found in the report"),
});

// The newline instruction is load-bearing. Gemini's structured-output mode strips line
// breaks from string fields, which runs the report's lines together
// ("...RAHUL MEHTAMRN 884213PHONE..."); the label-anchored, mostly \b-delimited PII rules
// in @/lib/pii-redaction cannot match that, so identifiers survive redaction.
const VISION_ANALYSIS_SCHEMA = TEXT_ANALYSIS_SCHEMA.extend({
  transcription: z
    .string()
    .describe(
      "Full verbatim text of the report, including identifiers. Preserve the report's " +
        "original line structure using \\n newline characters between lines."
    ),
});

type Triple = z.infer<typeof TRIPLE_SCHEMA>;

// Tuned for the embedding model in @/lib/embeddings (mxbai-embed-large-v1, 512-token
// limit): ~1200 chars stays well under that for dense clinical text, with overlap to
// preserve context across boundaries.
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;

// A PDF counts as born-digital only if its text layer yields this much text. Scanned or
// photographed PDFs return little or nothing and fall back to Gemini OCR.
const MIN_TEXT_LAYER_CHARS = 100;
const MIN_CHARS_PER_PAGE = 20;

// The prompts deliberately do not describe the JSON shape - the schemas above do, and
// repeating it invites the two to disagree.
const TEXT_ANALYSIS_PROMPT = `Below is the extracted text of a clinical report.
Go over it and identify biomarkers that show slight or large abnormalities, then summarize in about 100 words (you may exceed this for multi-page reports). Include numerical values, key details, and the report title.

Additionally, extract entity relationships as triples. Focus on medical entities like drugs, conditions, symptoms, and treatments.

## Clinical report text:
`;

const VISION_PROMPT = `Attached is a clinical report (image or scanned PDF).

1. Transcribe ALL text content from the report verbatim, including any patient names, dates, contact information, medical record numbers, and other identifying details exactly as they appear. This raw transcription is required for downstream security redaction.
2. Identify biomarkers that show slight or large abnormalities and summarize in about 100 words (you may exceed this for multi-page reports). Include numerical values, key details, and the report title.
3. Extract entity relationships as triples. Focus on medical entities like drugs, conditions, symptoms, and treatments.`;

// Mirrors the client's accept filter. The MIME type decides the extraction path, so an
// unrecognised one has nowhere to go - reject it here rather than sending arbitrary bytes
// to the vision model.
const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Vercel caps a serverless request body at ~4.5MB. The client refuses anything larger
// first, with a clearer message; this is the server-side backstop for a request that did
// not come from the client.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

class InvalidUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUploadError";
  }
}

// The upload arrives as multipart/form-data rather than a base64 data URL in JSON. JSON
// cannot carry binary, so the old shape cost 33% in transport and forced the whole file
// through memory as a string - which is why images were being re-encoded at JPEG quality
// 0.1 to fit, degrading the very pixels the OCR path has to read.
async function readUpload(req: Request): Promise<{ mimeType: string; buffer: Buffer }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new InvalidUploadError("Expected a multipart/form-data upload.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new InvalidUploadError("No file was included in the upload.");
  }
  if (file.size === 0) {
    throw new InvalidUploadError("The uploaded file is empty.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new InvalidUploadError(
      `File is too large (${Math.round(file.size / 1024 / 1024)}MB). The limit is ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      }MB.`
    );
  }
  // A browser sends the type it inferred from the file; it is not authoritative, but the
  // extraction paths are only defined for these four and Gemini re-reads the bytes itself.
  if (!ACCEPTED_MIME_TYPES.has(file.type)) {
    throw new InvalidUploadError(`Unsupported file type: ${file.type || "unknown"}.`);
  }

  return { mimeType: file.type, buffer: Buffer.from(await file.arrayBuffer()) };
}

// Carries a developer-facing detail; the route turns it into a 422 with a
// human-readable message.
class ExtractionFailedError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = "ExtractionFailedError";
  }
}

// generateObject throws on a safety block, a truncated response, or a hallucinated
// shape - all of which mean "this document couldn't be read" and belong in a 422.
// Anything else (network, auth, quota) is a server fault and rethrows as a 500.
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
  // The output is the raw text layer, identifiers included, so it is PHI-gated. The
  // metadata answers "how often do uploads fall back to OCR, and why".
  return span(
    "pdf_text_layer",
    { bytes: buffer.byteLength },
    async () => {
      try {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
          const result = await parser.getText();
          const text = stripPdfParseArtifacts(result.text ?? "");
          const pageCount = result.total || result.pages?.length || 1;
          const charsPerPage = text.length / pageCount;
          setSpanMetadata({ pageCount, chars: text.length, charsPerPage });

          if (text.length < MIN_TEXT_LAYER_CHARS || charsPerPage < MIN_CHARS_PER_PAGE) {
            setSpanMetadata({
              usable: false,
              reason:
                text.length < MIN_TEXT_LAYER_CHARS ? "too-few-chars" : "too-few-chars-per-page",
            });
            return null;
          }
          setSpanMetadata({ usable: true });
          return text;
        } finally {
          await parser.destroy();
        }
      } catch (error) {
        console.error("PDF text-layer extraction failed, will fall back to OCR:", error);
        setSpanMetadata({
          usable: false,
          reason: "parse-error",
          swallowedError: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    {
      runType: "parser",
      tags: ["pdf-parse", "pii-boundary"],
      safeOutputs: (text) => ({ usable: text !== null, ...textShape("text", text) }),
      recordOutputs: (text) => ({ usable: text !== null, text }),
    }
  );
}

// Both extraction paths are `llm` spans so token usage rolls up into cost. Their inputs
// are raw report text and a triple can name the patient before redactTriples runs, so
// both sides are PHI-gated.
async function analyzeText(fullText: string): Promise<{ summary: string; triples: Triple[] }> {
  const result = await span(
    "extract_from_text_layer",
    { prompt: TEXT_ANALYSIS_PROMPT, reportText: fullText },
    async () => {
      try {
        const { object, usage, finishReason } = await generateObject({
          model: geminiModel,
          schema: TEXT_ANALYSIS_SCHEMA,
          prompt: TEXT_ANALYSIS_PROMPT + fullText,
        });
        setSpanMetadata({
          inputChars: fullText.length,
          summaryChars: object.summary.length,
          triplesExtracted: object.triples.length,
          finishReason,
        });
        return { ...object, usage };
      } catch (error) {
        asExtractionFailure(error);
      }
    },
    {
      runType: "llm",
      tags: ["gemini", "extract", "text-layer", "pii-boundary"],
      metadata: llmMetadata(GEMINI_MODEL_ID),
      safeInputs: { prompt: TEXT_ANALYSIS_PROMPT, ...textShape("reportText", fullText) },
      safeOutputs: (r) => ({
        ...textShape("summary", r.summary),
        tripleCount: r.triples.length,
        ...usageMetadata(r.usage),
      }),
      recordOutputs: (r) => ({
        summary: r.summary,
        triples: r.triples,
        ...usageMetadata(r.usage),
      }),
    }
  );
  return { summary: result.summary, triples: result.triples };
}

// Images go as an image part; a scanned PDF goes as a file part with its mime type -
// Gemini reads the PDF itself in that case, which is the no-text-layer fallback.
async function transcribeAndAnalyze(
  mimeType: string,
  buffer: Buffer
): Promise<{ fullText: string; summary: string; triples: Triple[] }> {
  const result = await span(
    "ocr_transcribe_and_extract",
    // The document bytes are never recorded - megabytes of the most sensitive payload
    // in the request, where the size alone is all a trace needs.
    { prompt: VISION_PROMPT, mimeType, bytes: buffer.byteLength },
    async () => {
      try {
        const { object, usage, finishReason } = await generateObject({
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
        setSpanMetadata({
          transcriptionChars: object.transcription.length,
          summaryChars: object.summary.length,
          triplesExtracted: object.triples.length,
          finishReason,
          // An empty transcription means the fallback below kicked in and the whole
          // document was reduced to its ~100-word summary before chunking.
          transcriptionEmpty: !object.transcription,
        });
        return { ...object, usage };
      } catch (error) {
        asExtractionFailure(error);
      }
    },
    {
      runType: "llm",
      tags: ["gemini", "extract", "ocr", "pii-boundary"],
      metadata: llmMetadata(GEMINI_MODEL_ID),
      safeInputs: { prompt: VISION_PROMPT, mimeType, bytes: buffer.byteLength },
      safeOutputs: (r) => ({
        ...textShape("transcription", r.transcription),
        ...textShape("summary", r.summary),
        tripleCount: r.triples.length,
        ...usageMetadata(r.usage),
      }),
      recordOutputs: (r) => ({
        transcription: r.transcription,
        summary: r.summary,
        triples: r.triples,
        ...usageMetadata(r.usage),
      }),
    }
  );

  return {
    // Transcription drives redaction and chunking; the summary is a usable fallback
    // if the model returns an empty transcription for an unreadable scan.
    fullText: result.transcription || result.summary,
    summary: result.summary,
    triples: result.triples,
  };
}

export async function POST(req: Request) {
  let mimeType: string;
  let buffer: Buffer;
  try {
    ({ mimeType, buffer } = await readUpload(req));
  } catch (error) {
    if (error instanceof InvalidUploadError) {
      // A 400 rather than the 422 used for "read the file but couldn't understand it":
      // the request itself is malformed, and nothing was extracted to fail at.
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw error;
  }

  try {
    return await span(
      "ingest_report",
      { mimeType, bytes: buffer.byteLength },
      () => ingestReport(mimeType, buffer),
      {
        runType: "chain",
        tags: ["ingest", mimeType],
        recordOutputs: (response) => ({ status: response.status }),
      }
    );
  } finally {
    // The trace client batches uploads in the background and a serverless host can freeze
    // the function the instant the response is returned, so the batch has to be pushed on
    // every exit path - including the 422s and an unexpected throw.
    await flushTraces();
  }
}

async function ingestReport(mimeType: string, buffer: Buffer): Promise<Response> {
  let fullText: string;
  let summary: string;
  let triples: Triple[];
  let figures: FigureExtraction = NO_FIGURES;
  // The document's own text, before any figure description is appended - see documentId.
  let identityText: string | null = null;

  try {
    if (mimeType === "application/pdf") {
      const textLayer = await extractPdfTextLayer(buffer);
      if (textLayer) {
        setSpanMetadata({ extractionPath: "pdf-text-layer" });
        fullText = textLayer;
        ({ summary, triples } = await analyzeText(fullText));

        // Deliberately after analyzeText, so the summary and the graph triples are derived
        // from the report's own words only. A figure description is the model's reading of
        // a picture; promoting it into the summary that every prompt carries, or into the
        // graph as an asserted relationship, would let inference travel as fact. The
        // descriptions still reach the index below, which is what makes a question about a
        // chart answerable at all.
        figures = await describePdfFigures(buffer);
        identityText = fullText;
        fullText += figures.text;
      } else {
        setSpanMetadata({ extractionPath: "pdf-ocr-fallback" });
        ({ fullText, summary, triples } = await transcribeAndAnalyze(mimeType, buffer));
      }
    } else {
      setSpanMetadata({ extractionPath: "image-ocr" });
      ({ fullText, summary, triples } = await transcribeAndAnalyze(mimeType, buffer));
    }
  } catch (error) {
    if (error instanceof ExtractionFailedError) {
      console.error("Extraction failed:", error.detail);
      setSpanMetadata({ outcome: "extraction-failed", detail: error.detail });
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
    setSpanMetadata({ outcome: "no-text-extracted" });
    return new Response(JSON.stringify({ error: "Could not extract any text from the document" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }

  // The document text and the summary are redacted together so they share one coherent
  // vault: a given name or number maps to the same token in both.
  //
  // Every field on both sides of this span is PHI, so with capture off it records only
  // lengths and which token types fired - still enough to catch the failure that
  // matters, a report where redaction found nothing.
  const { redactedTexts, vault } = await span(
    "redact_document",
    { fullText, summary },
    async () => {
      const result = redactDocument([fullText, summary]);
      const tokens = Object.keys(result.vault);
      setSpanMetadata({
        piiCount: tokens.length,
        // e.g. { NAME: 2, MRN: 1, PHONE: 1 } - shows which rules actually fired.
        tokenTypes: tokens.reduce<Record<string, number>>((counts, token) => {
          const type = token.replace(/^\[|_\d+\]$/g, "");
          counts[type] = (counts[type] ?? 0) + 1;
          return counts;
        }, {}),
        inputChars: fullText.length,
        redactedChars: result.redactedTexts[0].length,
        foundNothing: tokens.length === 0,
      });
      return result;
    },
    {
      runType: "chain",
      tags: ["redaction", "pii-boundary"],
      safeInputs: { ...textShape("fullText", fullText), ...textShape("summary", summary) },
      safeOutputs: (result) => ({
        ...textShape("redactedFullText", result.redactedTexts[0]),
        ...textShape("redactedSummary", result.redactedTexts[1]),
        piiCount: Object.keys(result.vault).length,
        tokens: Object.keys(result.vault),
      }),
    }
  );
  const [redactedFullText, redactedSummary] = redactedTexts;
  const piiCount = Object.keys(vault).length;

  // Document identity comes from the RAW full text, deliberately not the redacted text.
  // Redaction is lossy by design - it replaces identifiers with positional tokens - so
  // two patients whose reports share the same clinical content redact to byte-identical
  // output. Hashing that would give them one shared id, and since the id is also the
  // vaultId, the second upload's vault would overwrite the first's and the first
  // patient's next answer would rehydrate with the second patient's name. Hashing the
  // raw text keeps dedup meaning what it should: the same bytes uploaded twice.
  //
  // Figure descriptions are excluded for a further reason: they are model output, so the
  // same file uploaded twice can produce differently worded text. Hashing that would give
  // one document two ids, defeating the dedup this is here to provide.
  const documentId = generateDocumentId(identityText ?? fullText);

  let chunkCount = 0;
  let vectorStoreFailed = false;
  const existingVault = await getVault(documentId);
  if (existingVault) {
    // Already ingested: refresh the vault TTL and skip the work.
    setSpanMetadata({ duplicate: true });
    await storeVault(documentId, existingVault);
  } else {
    setSpanMetadata({ duplicate: false });
    await storeVault(documentId, vault);

    // Errors here are swallowed so a Pinecone or HuggingFace outage still returns a
    // usable summary. The cost is a 200 carrying chunkCount: 0 - a document that is
    // silently unsearchable - so the span records the failure as an error.
    await span(
      "index_document",
      { documentId, chars: redactedFullText.length },
      async () => {
        try {
          const chunks = await span(
            "chunk_document",
            { chars: redactedFullText.length, chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP },
            async () => {
              const splitter = new RecursiveCharacterTextSplitter({
                chunkSize: CHUNK_SIZE,
                chunkOverlap: CHUNK_OVERLAP,
              });
              const split = await splitter.splitText(redactedFullText);
              setSpanMetadata({
                chunkCount: split.length,
                avgChunkChars: split.length
                  ? Math.round(split.reduce((sum, c) => sum + c.length, 0) / split.length)
                  : 0,
                maxChunkChars: split.reduce((max, c) => Math.max(max, c.length), 0),
              });
              return split;
            },
            {
              runType: "parser",
              tags: ["chunking"],
              // Chunk text is the whole redacted document again, which the parent span
              // already accounts for, so only the shape of the split is recorded.
              recordOutputs: (split) => ({
                chunkCount: split.length,
                chunkChars: split.map((c) => c.length),
              }),
            }
          );

          chunkCount = chunks.length;

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
          setSpanMetadata({ indexed: true, chunkCount });
          return { indexed: true, chunkCount };
        } catch (error) {
          console.error("Failed to chunk/embed/store document in Pinecone:", error);
          vectorStoreFailed = true;
          setSpanMetadata({
            indexed: false,
            swallowedError: error instanceof Error ? error.message : String(error),
          });
          // Rethrown so the span is marked failed and surfaces in LangSmith's error
          // view; caught immediately below to keep the 200 response.
          throw error;
        }
      },
      { runType: "chain", tags: ["indexing"] }
    ).catch(() => {
      // An indexing failure must not fail the upload.
    });
  }

  let graphStoreFailed = false;
  if (triples && Array.isArray(triples) && triples.length > 0) {
    // Input triples are pre-redaction (a triple can name the patient); the output is
    // post-vault, so only the input side needs gating.
    const redactedTriples = await span(
      "redact_triples",
      { triples, vaultTokens: Object.keys(vault).length },
      async () => {
        const result = redactTriples(triples, vault);
        setSpanMetadata({
          tripleCount: result.length,
          tokenisedTriples: result.filter((t) =>
            /\[[A-Z]+_\d+\]/.test(`${t.subject}${t.predicate}${t.object}`)
          ).length,
        });
        return result;
      },
      {
        runType: "chain",
        tags: ["redaction", "pii-boundary"],
        safeInputs: { tripleCount: triples.length, vaultTokens: Object.keys(vault).length },
        // Vault substitution only replaces values the rules actually found, so a
        // redacted triple can still name someone.
        safeOutputs: (result) => ({ tripleCount: result.length }),
      }
    );

    try {
      // The vault goes in so scoping is decided against what redaction actually found
      // rather than the token shape of the string alone: a value redactTriples failed to
      // substitute (it matches case-sensitively) would otherwise look like generic
      // knowledge and land in the graph's globally shared tier.
      await storeTriplesInNeo4j(redactedTriples, documentId, vault);
    } catch (error) {
      console.error("Failed to store triples in Neo4j:", error);
      // Same silent-200 shape as the indexing block above, so it gets the same
      // treatment: recorded on the root span rather than only in the console.
      graphStoreFailed = true;
      setSpanMetadata({
        graphStoreError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const response = {
    redactedSummary,
    vaultId: documentId,
    piiCount,
    triplesStored: triples ? triples.length : 0,
    chunkCount,
    // Reported rather than left to the trace: a figure the pipeline saw and could not read
    // is exactly the kind of thing this codebase has silently swallowed before.
    figuresDescribed: figures.described,
    figuresSkipped: figures.skipped,
    figuresFailed: figures.failed,
  };

  // Rolled onto the root span so one trace answers "did this upload actually land?".
  // A 200 with degraded: true is the case worth alerting on - the user saw success
  // while the document ended up unsearchable.
  setSpanMetadata({
    outcome: "ok",
    vaultId: documentId,
    piiCount,
    chunkCount,
    figuresDescribed: figures.described,
    figuresSkipped: figures.skipped,
    figuresFailed: figures.failed,
    triplesStored: triples ? triples.length : 0,
    vectorStoreFailed,
    graphStoreFailed,
    degraded: vectorStoreFailed || graphStoreFailed,
  });

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
