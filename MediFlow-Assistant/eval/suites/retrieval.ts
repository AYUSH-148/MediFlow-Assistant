import { queryPineconeVectorStoreDetailed, pinecone } from "@/utils";
import { gradeRetrieval } from "@/lib/retrieval-grader";
import { EVAL_INDEX, EVAL_NAMESPACE, findIngested, loadCorpus } from "../lib/corpus";
import { getReport } from "../fixtures/reports";
import { RETRIEVAL_CASES, type RetrievalCase } from "../dataset/retrieval";
import { EVAL_CONCURRENCY, mapWithConcurrency } from "../lib/concurrency";
import { createRetryCounter, withRetry } from "../lib/retry";
import {
  Confusion,
  containsFact,
  formatTable,
  heading,
  mean,
  ms,
  pct,
  subheading,
  summarizeLatency,
  type LatencySummary,
} from "../lib/metrics";

type Verdict = "relevant" | "partial" | "none";
const VERDICTS: readonly Verdict[] = ["relevant", "partial", "none"];

const RECALL_CUTOFFS = [1, 3, 5, 10] as const;

export interface RetrievalCaseResult {
  id: string;
  reportId: string;
  reportSize: "large" | "medium" | "small";
  question: string;
  chunksInReport: number;
  chunksRetrieved: number;
  /**
   * Whether this case has gold facts at all. `none` cases do not, and scoring recall
   * over a case with nothing to find would move the number for no reason.
   */
  hasGoldFacts: boolean;
  /** 1-based rank of the first retrieved chunk carrying a gold fact; null when none did. */
  firstHitRank: number | null;
  /** Fraction of this case's gold facts found anywhere in the retrieved set. */
  factRecall: number;
  expectedVerdict: Verdict;
  actualVerdict: Verdict;
  chunksKept: number;
  chunksDropped: number;
  ungraded: boolean;
  /** Whether a chunk carrying a gold fact survived grading. Null when there are no facts. */
  goldSurvivedGrading: boolean | null;
  retrieveMs: number;
  gradeMs: number;
}

export interface RetrievalSuiteResult {
  suite: "retrieval";
  concurrency: number;
  cases: RetrievalCaseResult[];
  report: string;
}

/**
 * Rebuilds the retrieval query exactly as app/api/medichatgemini/route.ts does.
 *
 * The whole report summary is prepended to the question. That is the production
 * behaviour and it is also the reason the grader exists - it makes every chunk of the
 * report score highly on report-to-report similarity regardless of what was asked - so
 * measuring against the bare question would flatter retrieval and mean nothing.
 */
function buildRetrievalQuery(summary: string, question: string): string {
  return `Represent this for searching relevant passages: patient medical report says: \n${summary}. \n\n${question}`;
}

async function runCase(
  testCase: RetrievalCase,
  manifest: ReturnType<typeof loadCorpus>,
  onRetry: (attempt: number, error: unknown) => void
): Promise<RetrievalCaseResult> {
  const ingested = findIngested(manifest, testCase.reportId);
  const report = getReport(testCase.reportId);
  const query = buildRetrievalQuery(ingested.redactedSummary, testCase.question);

  // Retrieval throws on an embedding or Pinecone failure, so it is retried. Grading is
  // not: gradeRetrieval catches its own errors and fails open, which means a transient
  // Gemini failure arrives here as `ungraded: true` rather than as an exception. That is
  // why the ungraded count is reported - it is the only signal separating "the grader
  // was unavailable" from "the grader made this call".
  const retrieveStart = performance.now();
  const retrieval = await withRetry(
    () =>
      queryPineconeVectorStoreDetailed(pinecone, EVAL_INDEX, EVAL_NAMESPACE, query, {
        documentId: { $eq: ingested.documentId },
      }),
    { label: `retrieve ${testCase.id}`, onRetry }
  );
  const retrieveMs = performance.now() - retrieveStart;

  const hasFacts = testCase.expectedFacts.length > 0;
  const chunkCarriesFact = (text: string) =>
    testCase.expectedFacts.some((fact) => containsFact(text, fact));

  const hitIndex = retrieval.chunks.findIndex((chunk) => chunkCarriesFact(chunk.text));
  const firstHitRank = hasFacts && hitIndex !== -1 ? hitIndex + 1 : null;

  const factsFound = testCase.expectedFacts.filter((fact) =>
    retrieval.chunks.some((chunk) => containsFact(chunk.text, fact))
  ).length;

  // The grader receives the BARE question, not the summary-prefixed query - that
  // asymmetry is the whole design of the corrective step.
  const gradeStart = performance.now();
  const graded = await gradeRetrieval({
    question: testCase.question,
    retrievalText: retrieval.text,
    chunks: retrieval.chunks,
  });
  const gradeMs = performance.now() - gradeStart;

  return {
    id: testCase.id,
    reportId: testCase.reportId,
    reportSize: report.size,
    question: testCase.question,
    chunksInReport: ingested.chunkCount,
    chunksRetrieved: retrieval.chunks.length,
    hasGoldFacts: hasFacts,
    firstHitRank,
    factRecall: hasFacts ? factsFound / testCase.expectedFacts.length : 1,
    expectedVerdict: testCase.expectedVerdict,
    actualVerdict: graded.verdict,
    chunksKept: graded.chunks.length,
    chunksDropped: retrieval.chunks.length - graded.chunks.length,
    ungraded: graded.ungraded,
    goldSurvivedGrading: hasFacts ? graded.chunks.some((chunk) => chunkCarriesFact(chunk.text)) : null,
    retrieveMs,
    gradeMs,
  };
}

// Only cases with gold facts are scorable for retrieval. A "none" case has nothing to
// find, so including it would move recall for no reason in either direction.
function scorableFor(results: RetrievalCaseResult[]): RetrievalCaseResult[] {
  return results.filter((result) => result.hasGoldFacts);
}

function recallAt(results: RetrievalCaseResult[], k: number): number {
  const scorable = scorableFor(results);
  if (scorable.length === 0) return 0;
  const hits = scorable.filter((r) => r.firstHitRank !== null && r.firstHitRank <= k).length;
  return hits / scorable.length;
}

function meanReciprocalRank(results: RetrievalCaseResult[]): number {
  const scorable = scorableFor(results);
  if (scorable.length === 0) return 0;
  return mean(scorable.map((r) => (r.firstHitRank ? 1 / r.firstHitRank : 0)));
}

function retrievalBlock(label: string, results: RetrievalCaseResult[]): string {
  const scorable = scorableFor(results);
  if (scorable.length === 0) return `${label}: no scorable cases`;

  const rows = RECALL_CUTOFFS.map((k) => [
    `recall@${k}`,
    pct(recallAt(results, k)),
    `${scorable.filter((r) => r.firstHitRank !== null && r.firstHitRank <= k).length}/${scorable.length}`,
  ]);
  rows.push(["MRR", meanReciprocalRank(results).toFixed(3), ""]);
  rows.push(["fact recall", pct(mean(scorable.map((r) => r.factRecall))), "facts found / facts labelled"]);

  const avgRetrieved = mean(results.map((r) => r.chunksRetrieved));
  const avgAvailable = mean(results.map((r) => r.chunksInReport));
  rows.push([
    "selectivity",
    `${avgRetrieved.toFixed(1)}/${avgAvailable.toFixed(1)}`,
    avgRetrieved >= avgAvailable
      ? "topK >= report size: every chunk returned, recall@10 is tautological"
      : "retrieval is discarding chunks",
  ]);

  return `${subheading(label)}\n${formatTable(["metric", "value", "detail"], rows)}`;
}

export async function runRetrievalSuite(
  log: (line: string) => void = console.log
): Promise<RetrievalSuiteResult> {
  const manifest = loadCorpus();

  log(`Running ${RETRIEVAL_CASES.length} retrieval cases (concurrency ${EVAL_CONCURRENCY})...`);

  const retries = createRetryCounter();
  const cases = await mapWithConcurrency(RETRIEVAL_CASES, EVAL_CONCURRENCY, async (testCase, index) => {
    const result = await runCase(testCase, manifest, retries.onRetry);
    log(
      `  [${String(index + 1).padStart(2)}/${RETRIEVAL_CASES.length}] ${testCase.id.padEnd(26)} ` +
        `rank=${result.firstHitRank ?? "-"}  verdict=${result.actualVerdict}` +
        `${result.actualVerdict === result.expectedVerdict ? "" : ` (expected ${result.expectedVerdict})`}`
    );
    return result;
  });

  // ---------------------------------------------------------------- grading analysis
  const confusion = new Confusion<Verdict>(VERDICTS);
  for (const result of cases) confusion.record(result.expectedVerdict, result.actualVerdict);

  // The report's own information is withheld from the user: the grader called a covered
  // question uncovered, and buildGroundingInstruction then tells the model to say the
  // report does not contain it. This is the failure mode that makes the feature worse
  // than not having it.
  const falseRefusals = cases.filter(
    (r) => r.expectedVerdict !== "none" && r.actualVerdict === "none"
  );
  // The opposite: padding passed through as evidence on a question the report cannot
  // answer, which is what the grader was added to stop.
  const falseGrounding = cases.filter(
    (r) => r.expectedVerdict === "none" && r.actualVerdict !== "none"
  );
  // Retrieval found the answer and grading threw it away. Distinct from a false refusal:
  // the verdict can still be "relevant" while the one chunk that mattered was dropped.
  const goldDropped = cases.filter(
    (r) => r.firstHitRank !== null && r.goldSurvivedGrading === false
  );

  const scorableGold = cases.filter((r) => r.goldSurvivedGrading !== null && r.firstHitRank !== null);

  const gradingRows: Array<[string, string, string]> = [
    ["verdict agreement", pct(confusion.accuracy()), `${cases.length} cases`],
    [
      "gold chunk survives grading",
      scorableGold.length
        ? pct(scorableGold.filter((r) => r.goldSurvivedGrading).length / scorableGold.length)
        : "n/a",
      `${scorableGold.filter((r) => r.goldSurvivedGrading).length}/${scorableGold.length} retrieved-and-kept`,
    ],
    [
      "false refusals",
      String(falseRefusals.length),
      falseRefusals.length ? falseRefusals.map((r) => r.id).join(", ") : "none",
    ],
    [
      "false grounding",
      String(falseGrounding.length),
      falseGrounding.length ? falseGrounding.map((r) => r.id).join(", ") : "none",
    ],
    [
      "answer dropped by grader",
      String(goldDropped.length),
      goldDropped.length ? goldDropped.map((r) => r.id).join(", ") : "none",
    ],
    [
      "ungraded (grader failed open)",
      String(cases.filter((r) => r.ungraded).length),
      "includes transient Gemini failures - gradeRetrieval swallows those",
    ],
    ["retries during run", String(retries.count()), "transient retrieval failures re-attempted"],
    [
      "chunks kept / retrieved",
      `${mean(cases.map((r) => r.chunksKept)).toFixed(1)}/${mean(cases.map((r) => r.chunksRetrieved)).toFixed(1)}`,
      `${pct(1 - mean(cases.map((r) => r.chunksKept)) / Math.max(mean(cases.map((r) => r.chunksRetrieved)), 1))} of retrieved context discarded`,
    ],
  ];

  const retrieveLatency: LatencySummary = summarizeLatency(cases.map((r) => r.retrieveMs));
  const gradeLatency: LatencySummary = summarizeLatency(cases.map((r) => r.gradeMs));

  const perClass = confusion.perClass();

  const report = [
    heading("RETRIEVAL AND CORRECTIVE-RAG GRADING"),
    "",
    `Corpus: ${manifest.reports.length} documents, ` +
      `${manifest.reports.reduce((sum, r) => sum + r.chunkCount, 0)} chunks, ` +
      `namespace "${manifest.namespace}" (built ${manifest.builtAt}).`,
    `Cases: ${RETRIEVAL_CASES.length} ` +
      `(${cases.filter((c) => c.expectedVerdict === "relevant").length} relevant, ` +
      `${cases.filter((c) => c.expectedVerdict === "partial").length} partial, ` +
      `${cases.filter((c) => c.expectedVerdict === "none").length} none).`,
    "",
    retrievalBlock("Retrieval - all reports", cases),
    retrievalBlock("Retrieval - large reports (more chunks than topK)", cases.filter((r) => r.reportSize === "large")),
    retrievalBlock("Retrieval - medium and small reports (fit inside topK)", cases.filter((r) => r.reportSize !== "large")),
    "",
    subheading("Grading"),
    formatTable(["metric", "value", "detail"], gradingRows),
    "",
    subheading("Grading - verdict confusion"),
    formatTable(confusion.toTable().headers, confusion.toTable().rows),
    "",
    formatTable(
      ["verdict", "precision", "recall", "labelled", "predicted"],
      perClass.map((entry) => [
        entry.label,
        pct(entry.precision),
        pct(entry.recall),
        String(entry.support),
        String(entry.predicted),
      ])
    ),
    "",
    subheading("Latency"),
    EVAL_CONCURRENCY > 1
      ? `NOTE: run at concurrency ${EVAL_CONCURRENCY}; these figures include contention and are not comparable to a serial run.`
      : "Serial run - one case at a time, so these are uncontended per-stage costs.",
    formatTable(
      ["stage", "p50", "p95", "max", "mean"],
      [
        ["hybrid retrieval", ms(retrieveLatency.p50), ms(retrieveLatency.p95), ms(retrieveLatency.max), ms(retrieveLatency.mean)],
        ["grading (Gemini)", ms(gradeLatency.p50), ms(gradeLatency.p95), ms(gradeLatency.max), ms(gradeLatency.mean)],
        [
          "combined",
          ms(retrieveLatency.p50 + gradeLatency.p50),
          ms(retrieveLatency.p95 + gradeLatency.p95),
          "",
          ms(retrieveLatency.mean + gradeLatency.mean),
        ],
      ]
    ),
    "",
    "Grading runs after retrieval, so its cost is added to every uncached answer.",
  ].join("\n");

  return { suite: "retrieval", concurrency: EVAL_CONCURRENCY, cases, report };
}
