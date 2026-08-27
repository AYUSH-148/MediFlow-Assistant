import { generateObject } from "ai";
import { z } from "zod";
import { geminiModel, GEMINI_MODEL_ID } from "@/lib/gemini";
import {
  span,
  setSpanMetadata,
  textShape,
  llmMetadata,
  usageMetadata,
} from "@/lib/tracing";

// One entry per page sent, so a page whose figure turns out to be decorative can be
// reported as such rather than forcing the model to invent a clinical description.
export const FIGURE_SCHEMA = z.object({
  figures: z
    .array(
      z.object({
        page: z.number().describe("The 1-based page number this figure appears on."),
        description: z
          .string()
          .describe(
            "What the figure shows, in one or two sentences: the modality or chart type " +
            "and any finding legible in it. Empty string if the page holds nothing " +
            "clinically meaningful (a logo, a signature, a decorative rule)."
          ),
      })
    )
    .describe("One entry per page provided, in the same order."),
});

// A figure is described, not transcribed: the text layer already carries the page's words
// losslessly, so asking for a transcription here would only invite a second, worse reading
// of numbers that were already read exactly.
const FIGURE_PROMPT = `Each image below is one full page of a clinical report that contains an embedded figure - a chart, trace, scan, diagram or flowchart.

The page's text has already been extracted separately and accurately. Do NOT transcribe the text. Describe only what the FIGURE shows: what kind of figure it is, and any finding that is legible in it.

If a page's only image turns out to be decorative - a letterhead logo, a signature, a rule or a watermark - return an empty description for that page rather than inventing a clinical reading.

Return one entry per page, in the order the pages are given, using the page numbers stated with each image.`;

// An embedded image has to clear both bars to be worth a vision call. Letterhead logos,
// signature scans and rules are all "images" as far as the PDF is concerned.
//
// This is a heuristic, not a rule, and a knowingly imperfect one: width/height here are the
// image RESOURCE dimensions, not the size it is drawn at, so a large photo placed as a
// thumbnail passes and a small icon scaled up does not. Both counts are recorded so the
// thresholds can be tuned against real uploads instead of defended in the abstract.
const MIN_FIGURE_EDGE_PX = 150;
const MIN_FIGURE_AREA_PX = 40_000;

// Every qualifying page goes in ONE request - Gemini accepts multiple images per call - so
// this bounds tokens rather than round trips. The route's own maxDuration of 60s is the
// real ceiling, and a report with figures on more pages than this is far outside what the
// app is for; the overflow is reported rather than dropped quietly.
const MAX_FIGURE_PAGES = 8;

export interface FigureExtraction {
  /** Labelled block to append to the document text, or "" when there is nothing to add. */
  text: string;
  pagesWithFigures: number;
  described: number;
  /** Qualifying pages beyond MAX_FIGURE_PAGES that were never looked at. */
  skipped: number;
  /** True when detection or description threw. The text-layer result still stands. */
  failed: boolean;
}

export const NO_FIGURES: FigureExtraction = {
  text: "",
  pagesWithFigures: 0,
  described: 0,
  skipped: 0,
  failed: false,
};

// pdf-parse is loaded here rather than imported at module scope. Its bundle constructs a
// DOMMatrix as it loads and relies on @napi-rs/canvas to polyfill that under Node, and it
// reaches for the package through a guarded runtime require that bundlers cannot trace. A
// deployment that ships without the binary would take the whole ingest route down before
// any handler ran - a 500 on every request - because a module-scope throw happens outside
// the degrade-to-no-figures handling below. Loaded on demand, it costs the figures only.
async function loadPdfParse() {
  const { PDFParse } = await import("pdf-parse");
  return PDFParse;
}

/**
 * Find, render and describe the figures in a born-digital PDF.
 *
 * The text-layer path reads a page's words exactly and its pictures not at all - and it is
 * chosen precisely BECAUSE the PDF has text, so an ECG trace or an echo still sitting in a
 * text-bearing report was dropped with nothing recorded to say so. `charsPerPage` looks
 * healthy either way.
 *
 * This closes that without touching what already works. The text layer stays authoritative:
 * figures are added to it, never substituted for it. Routing a whole document to vision
 * because a chart appeared would trade exact lab values for a model's re-reading of them,
 * which is the regression the text-layer-first design exists to prevent.
 *
 * Three local, free steps decide whether a paid one is warranted: getImage() reports which
 * pages carry an image and how big it is, the size filter drops decorative ones, and
 * getScreenshot() renders only the survivors. A report with no figures never reaches Gemini.
 *
 * Whole pages are rendered rather than the extracted image bytes on purpose - a chart
 * stripped of its caption, axis labels and section heading is materially harder to read.
 */
export async function describePdfFigures(buffer: Buffer): Promise<FigureExtraction> {
  return span(
    "describe_figures",
    { bytes: buffer.byteLength },
    async () => {
      let figurePages: number[] = [];
      let imageCount = 0;

      // Detection is local and cheap, but a malformed image dictionary should not cost the
      // upload its text - which extracted fine - so it degrades to "no figures".
      try {
        const PDFParse = await loadPdfParse();
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
          const result = await parser.getImage();
          for (const page of result.pages ?? []) {
            const images = page.images ?? [];
            imageCount += images.length;
            const meaningful = images.some(
              (image) =>
                image.width >= MIN_FIGURE_EDGE_PX &&
                image.height >= MIN_FIGURE_EDGE_PX &&
                image.width * image.height >= MIN_FIGURE_AREA_PX
            );
            if (meaningful) figurePages.push(page.pageNumber);
          }
        } finally {
          await parser.destroy();
        }
      } catch (error) {
        console.error("Figure detection failed; continuing with text only:", error);
        setSpanMetadata({
          outcome: "detection-failed",
          swallowedError: error instanceof Error ? error.message : String(error),
        });
        return { ...NO_FIGURES, failed: true };
      }

      setSpanMetadata({ imageCount, pagesWithFigures: figurePages.length });

      if (figurePages.length === 0) {
        // The common case for a text report, and it costs nothing beyond the local scan.
        setSpanMetadata({ outcome: "no-figures" });
        return NO_FIGURES;
      }

      const selected = figurePages.slice(0, MAX_FIGURE_PAGES);
      const skipped = figurePages.length - selected.length;

      try {
        const PDFParse = await loadPdfParse();
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        let shots;
        try {
          shots = (await parser.getScreenshot({ partial: selected })).pages ?? [];
        } finally {
          await parser.destroy();
        }
        if (shots.length === 0) {
          setSpanMetadata({ outcome: "render-empty" });
          return { ...NO_FIGURES, pagesWithFigures: figurePages.length, failed: true };
        }

        const described = await describeFigurePages(shots);

        // An empty description is the model reporting a decorative image, which is a
        // correct answer and not something to paste into the document.
        const usable = described.filter((figure) => figure.description.trim().length > 0);

        setSpanMetadata({
          outcome: "described",
          rendered: shots.length,
          returned: described.length,
          usable: usable.length,
          decorative: described.length - usable.length,
          skipped,
        });

        if (usable.length === 0) {
          return { text: "", pagesWithFigures: figurePages.length, described: 0, skipped, failed: false };
        }

        // Labelled, and labelled in the document text itself rather than in metadata, because
        // this block travels all the way into the chunks and the answer prompt. A described
        // figure is the model's reading of a picture, not something the report states; if it
        // arrives looking like transcribed text, neither the grader nor the generator can
        // tell evidence from inference.
        const text =
          "\n\n--- FIGURES (described from page images, not transcribed text) ---\n" +
          usable
            .map((figure) => `Figure (page ${figure.page}): ${figure.description.trim()}`)
            .join("\n");

        return { text, pagesWithFigures: figurePages.length, described: usable.length, skipped, failed: false };
      } catch (error) {
        // Same posture as the indexing and graph writes: a figure is an enrichment, and
        // losing it must never cost the user an upload whose text came through fine.
        console.error("Figure description failed; continuing with text only:", error);
        setSpanMetadata({
          outcome: "description-failed",
          skipped,
          swallowedError: error instanceof Error ? error.message : String(error),
        });
        return { ...NO_FIGURES, pagesWithFigures: figurePages.length, skipped, failed: true };
      }
    },
    {
      runType: "chain",
      tags: ["figures", "pii-boundary"],
      safeOutputs: (result) => ({
        pagesWithFigures: result.pagesWithFigures,
        described: result.described,
        skipped: result.skipped,
        failed: result.failed,
        ...textShape("figureText", result.text),
      }),
      recordOutputs: (result) => ({ figureText: result.text }),
    }
  );
}

/**
 * One request carrying every figure page.
 *
 * Gemini takes multiple images per call, so batching turns N round trips into one - which is
 * what keeps this affordable inside the route's 60s budget. Pages are numbered in the text
 * part rather than left to positional inference, so a dropped or reordered entry in the
 * response is still attributable to the right page.
 */
async function describeFigurePages(
  shots: Array<{ data: Uint8Array; pageNumber: number }>
): Promise<Array<{ page: number; description: string }>> {
  const pageList = shots.map((shot) => shot.pageNumber);

  const result = await span(
    "figure_vision",
    { prompt: FIGURE_PROMPT, pages: pageList },
    async () => {
      const { object, usage, finishReason } = await generateObject({
        model: geminiModel,
        schema: FIGURE_SCHEMA,
        // Descriptive, not creative. This text is appended to the document and indexed, so
        // the same report re-uploaded should not produce differently worded evidence.
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: FIGURE_PROMPT },
              ...shots.flatMap((shot) => [
                { type: "text" as const, text: `Page ${shot.pageNumber}:` },
                {
                  type: "image" as const,
                  image: Buffer.from(shot.data),
                  mimeType: "image/png",
                },
              ]),
            ],
          },
        ],
      });
      setSpanMetadata({ figuresReturned: object.figures.length, finishReason });
      return { ...object, usage };
    },
    {
      runType: "llm",
      tags: ["gemini", "figures", "vision", "pii-boundary"],
      metadata: llmMetadata(GEMINI_MODEL_ID),
      // The rendered pages are the report itself as pixels - the most sensitive payload in
      // the request - so only their count and page numbers are ever recorded.
      safeInputs: { prompt: FIGURE_PROMPT, pages: pageList, imageCount: shots.length },
      safeOutputs: (r) => ({ figureCount: r.figures.length, ...usageMetadata(r.usage) }),
      recordOutputs: (r) => ({ figures: r.figures, ...usageMetadata(r.usage) }),
    }
  );

  // Only pages that were actually sent: a hallucinated page number would attach a
  // description to a page nobody looked at.
  const sent = new Set(pageList);
  return result.figures.filter((figure) => sent.has(figure.page));
}

