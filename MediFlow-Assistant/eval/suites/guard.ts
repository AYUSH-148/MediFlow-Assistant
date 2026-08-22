import { guardQuestion } from "@/lib/query-guard";
import { GUARD_CASES, type GuardCase } from "../dataset/guard";
import { EVAL_CONCURRENCY, mapWithConcurrency } from "../lib/concurrency";
import {
  Confusion,
  formatTable,
  heading,
  ms,
  pct,
  subheading,
  summarizeLatency,
} from "../lib/metrics";

type Intent = "answer" | "clarify" | "refuse";
const INTENTS: readonly Intent[] = ["answer", "clarify", "refuse"];

export interface GuardCaseResult {
  id: string;
  message: string;
  hasReport: boolean;
  hasHistory: boolean;
  expectedIntent: Intent;
  actualIntent: Intent;
  expectRewrite: boolean | null;
  rewritten: boolean;
  resolvedQuestion: string;
  reply: string;
  latencyMs: number;
}

export interface GuardSuiteResult {
  suite: "guard";
  concurrency: number;
  cases: GuardCaseResult[];
  report: string;
}

/**
 * Assembles conversation history the way app/api/medichatgemini/route.ts does - the last
 * four messages, role-prefixed and newline joined, with the literal fallback string when
 * there is no prior turn. Formatting it any other way would be testing a prompt the guard
 * never actually receives.
 */
function formatHistory(history: GuardCase["history"]): string {
  if (history.length === 0) return "No prior conversation history";
  return history
    .slice(-4)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");
}

async function runCase(testCase: GuardCase): Promise<GuardCaseResult> {
  const start = performance.now();
  const guard = await guardQuestion({
    question: testCase.message,
    history: formatHistory(testCase.history),
    hasReport: testCase.hasReport,
  });
  const latencyMs = performance.now() - start;

  return {
    id: testCase.id,
    message: testCase.message,
    hasReport: testCase.hasReport,
    hasHistory: testCase.history.length > 0,
    expectedIntent: testCase.expectedIntent,
    actualIntent: guard.intent,
    expectRewrite: testCase.expectRewrite ?? null,
    // The same comparison query-guard.ts records as `rewritten` in its span metadata.
    rewritten: guard.resolvedQuestion !== testCase.message,
    resolvedQuestion: guard.resolvedQuestion,
    reply: guard.reply,
    latencyMs,
  };
}

export async function runGuardSuite(
  log: (line: string) => void = console.log
): Promise<GuardSuiteResult> {
  log(`Running ${GUARD_CASES.length} guard cases (concurrency ${EVAL_CONCURRENCY})...`);

  const cases = await mapWithConcurrency(GUARD_CASES, EVAL_CONCURRENCY, async (testCase, index) => {
    const result = await runCase(testCase);
    log(
      `  [${String(index + 1).padStart(2)}/${GUARD_CASES.length}] ${testCase.id.padEnd(30)} ` +
        `${result.actualIntent}` +
        `${result.actualIntent === result.expectedIntent ? "" : ` (expected ${result.expectedIntent})`}`
    );
    return result;
  });

  const confusion = new Confusion<Intent>(INTENTS);
  for (const result of cases) confusion.record(result.expectedIntent, result.actualIntent);

  // An off-topic question answered from general knowledge is the failure the guard was
  // built to prevent, and it is doubly costly: the answer is cached for 24 hours and,
  // with a report loaded, written into long-term conversation memory.
  const leakedThrough = cases.filter(
    (r) => r.expectedIntent === "refuse" && r.actualIntent === "answer"
  );
  // The opposite miscalibration - refusing something legitimately in scope - is what
  // users experience as the assistant becoming useless.
  const overRefused = cases.filter(
    (r) => r.expectedIntent !== "refuse" && r.actualIntent === "refuse"
  );

  const rewriteCases = cases.filter((r) => r.expectRewrite === true);
  const noRewriteCases = cases.filter((r) => r.expectRewrite === false);
  const rewritesLanded = rewriteCases.filter((r) => r.actualIntent === "answer" && r.rewritten);
  // A self-contained question the guard rewrote anyway. Harmless for the answer, but it
  // changes the cache key, so two identical questions can end up in different slots.
  const spuriousRewrites = noRewriteCases.filter((r) => r.actualIntent === "answer" && r.rewritten);

  const latency = summarizeLatency(cases.map((r) => r.latencyMs));
  const perClass = confusion.perClass();

  const rewriteRows = rewriteCases.map((r) => [
    r.id,
    r.rewritten ? "yes" : "NO",
    r.resolvedQuestion.length > 62 ? `${r.resolvedQuestion.slice(0, 59)}...` : r.resolvedQuestion,
  ]);

  const report = [
    heading("QUERY GUARD"),
    "",
    `Cases: ${GUARD_CASES.length} ` +
      `(${cases.filter((c) => c.expectedIntent === "answer").length} answer, ` +
      `${cases.filter((c) => c.expectedIntent === "clarify").length} clarify, ` +
      `${cases.filter((c) => c.expectedIntent === "refuse").length} refuse).`,
    "",
    subheading("Routing"),
    formatTable(
      ["metric", "value", "detail"],
      [
        ["intent accuracy", pct(confusion.accuracy()), `${cases.length} cases`],
        [
          "off-topic leaked through",
          String(leakedThrough.length),
          leakedThrough.length ? leakedThrough.map((r) => r.id).join(", ") : "none",
        ],
        [
          "in-scope over-refused",
          String(overRefused.length),
          overRefused.length ? overRefused.map((r) => r.id).join(", ") : "none",
        ],
      ]
    ),
    "",
    subheading("Routing - intent confusion"),
    formatTable(confusion.toTable().headers, confusion.toTable().rows),
    "",
    formatTable(
      ["intent", "precision", "recall", "labelled", "predicted"],
      perClass.map((entry) => [
        entry.label,
        pct(entry.precision),
        pct(entry.recall),
        String(entry.support),
        String(entry.predicted),
      ])
    ),
    "",
    subheading("Question rewriting"),
    formatTable(
      ["metric", "value", "detail"],
      [
        [
          "context-dependent rewritten",
          rewriteCases.length ? pct(rewritesLanded.length / rewriteCases.length) : "n/a",
          `${rewritesLanded.length}/${rewriteCases.length} follow-ups resolved to standalone form`,
        ],
        [
          "self-contained left alone",
          noRewriteCases.length
            ? pct(1 - spuriousRewrites.length / noRewriteCases.length)
            : "n/a",
          spuriousRewrites.length
            ? `rewritten anyway: ${spuriousRewrites.map((r) => r.id).join(", ")}`
            : "none rewritten unnecessarily",
        ],
      ]
    ),
    "",
    rewriteCases.length
      ? `${formatTable(["case", "rewritten", "resolved question"], rewriteRows)}\n`
      : "",
    subheading("Latency"),
    EVAL_CONCURRENCY > 1
      ? `NOTE: run at concurrency ${EVAL_CONCURRENCY}; figures include contention.`
      : "Serial run.",
    formatTable(
      ["stage", "p50", "p95", "max", "mean"],
      [["query guard (Gemini)", ms(latency.p50), ms(latency.p95), ms(latency.max), ms(latency.mean)]]
    ),
    "",
    "The guard runs on EVERY chat turn, before the cache lookup, so this cost is paid",
    "even on requests that go on to be served from cache.",
  ].join("\n");

  return { suite: "guard", concurrency: EVAL_CONCURRENCY, cases, report };
}
