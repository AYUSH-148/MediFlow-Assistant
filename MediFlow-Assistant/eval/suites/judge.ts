import {
  GROQ_JUDGE_MODEL,
  JUDGE_PROVIDER,
  buildPrompt,
  judgeWithGemini,
  judgeWithGroq,
  numbersNotInEvidence,
  settleVerdict,
} from "@/lib/answer-checker";
import { GEMINI_MODEL_ID } from "@/lib/gemini";
import { JUDGE_CASES, buildEvidence, type JudgeCase, type JudgeVerdict } from "../dataset/judge";
import { EVAL_CONCURRENCY, mapWithConcurrency } from "../lib/concurrency";
import { createRetryCounter, withRetry } from "../lib/retry";
import { Confusion, formatTable, heading, ms, pct, subheading, summarizeLatency } from "../lib/metrics";

const VERDICTS: readonly JudgeVerdict[] = ["grounded", "partial", "unsupported"];

/**
 * Judges with the provider JUDGE_PROVIDER selects, calling the production judge function
 * for it directly - not checkAnswer, whose Groq-to-Gemini fallback would quietly mix two
 * models' verdicts into one score. Same prompt and schema either way, so a difference
 * between a Gemini run and a Groq run is the model's.
 */
interface JudgeOutcome {
  verdict: JudgeVerdict;
  unsupportedClaims: string[];
  judgeFailed: boolean;
  /** Groq only. Its free tier is limited by tokens per minute, so this decides feasibility. */
  tokens: number | null;
}

async function judge(question: string, evidence: string, answer: string): Promise<JudgeOutcome> {
  const prompt = buildPrompt(question, evidence, answer, numbersNotInEvidence(answer, evidence));
  const { object, tokens } = JUDGE_PROVIDER === "groq" ? await judgeWithGroq(prompt) : await judgeWithGemini(prompt);
  return { ...settleVerdict(object), judgeFailed: false, tokens };
}

export interface JudgeCaseResult {
  id: string;
  expected: JudgeVerdict;
  actual: JudgeVerdict;
  /** Report sections in the evidence; 10 is the whole report, production-sized. */
  sections: number;
  unsupportedClaims: string[];
  /**
   * The judge call failed after retries and is scored as "grounded". Recorded per case for
   * the same reason as the guard suite's guardFailed: an outage scores exactly like a
   * judge that accepts everything.
   */
  judgeFailed: boolean;
  attempts: number;
  tokens: number | null;
  latencyMs: number;
  note: string;
}

export interface JudgeSuiteResult {
  suite: "judge";
  judge: string;
  concurrency: number;
  cases: JudgeCaseResult[];
  report: string;
}

async function runCase(
  testCase: JudgeCase,
  onRetry: (attempt: number, error: unknown) => void
): Promise<JudgeCaseResult> {
  const evidence = buildEvidence(testCase);
  const start = performance.now();
  let attempts = 0;

  let outcome: JudgeOutcome;
  try {
    // Longer backoff than the other suites: both free tiers limit per minute (Gemini 5
    // requests, Groq 8K tokens), so a 1.5s retry just lands in the same window.
    outcome = await withRetry(
      () => {
        attempts += 1;
        return judge(testCase.question, evidence, testCase.answer);
      },
      {
        attempts: 6,
        baseDelayMs: 5000,
        label: `judge ${testCase.id}`,
        onRetry,
      }
    );
  } catch (error) {
    // Recorded as an outage rather than thrown, so one bad case does not lose the run.
    console.error(`    judge ${testCase.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    outcome = { verdict: "grounded", unsupportedClaims: [], judgeFailed: true, tokens: null };
  }

  return {
    id: testCase.id,
    expected: testCase.expected,
    actual: outcome.verdict,
    sections: testCase.sections.length,
    unsupportedClaims: outcome.unsupportedClaims,
    judgeFailed: outcome.judgeFailed,
    attempts,
    tokens: outcome.tokens,
    latencyMs: performance.now() - start,
    note: testCase.note,
  };
}

// JUDGE_ONLY=id1,id2 reruns just those cases - a full Groq run takes ~30 minutes under the
// free tier's token limit, too long to repeat for a few outages.
const ONLY = process.env.JUDGE_ONLY?.split(",").map((id) => id.trim()).filter(Boolean);
const SELECTED_CASES = ONLY?.length ? JUDGE_CASES.filter((c) => ONLY.includes(c.id)) : JUDGE_CASES;

export async function runJudgeSuite(log: (line: string) => void = console.log): Promise<JudgeSuiteResult> {
  const judgeLabel = JUDGE_PROVIDER === "groq" ? `groq ${GROQ_JUDGE_MODEL}` : `gemini ${GEMINI_MODEL_ID}`;
  log(`Running ${SELECTED_CASES.length} judge cases with ${judgeLabel} (concurrency ${EVAL_CONCURRENCY})...`);

  const retries = createRetryCounter();
  const cases = await mapWithConcurrency(SELECTED_CASES, EVAL_CONCURRENCY, async (testCase, index) => {
    const result = await runCase(testCase, retries.onRetry);
    log(
      `  [${String(index + 1).padStart(2)}/${SELECTED_CASES.length}] ${testCase.id.padEnd(26)} ` +
        `${result.actual}${result.actual === result.expected ? "" : ` (expected ${result.expected})`}` +
        `${result.attempts > 1 ? `  (${result.attempts} attempts)` : ""}` +
        `${result.judgeFailed ? "  << JUDGE OUTAGE, not a verdict" : ""}`
    );
    return result;
  });

  const outages = cases.filter((r) => r.judgeFailed);
  const confusion = new Confusion<JudgeVerdict>(VERDICTS);
  for (const result of cases) confusion.record(result.expected, result.actual);

  // The route only branches on grounded vs not, so that is the headline.
  const passFailCorrect = cases.filter((r) => (r.expected === "grounded") === (r.actual === "grounded"));
  // A bad answer let through reaches the user and the 24h cache. The costliest error.
  const falseAccepts = cases.filter((r) => r.expected !== "grounded" && r.actual === "grounded");
  // A good answer rejected costs a retry (two more model calls) and may come back worse.
  const falseRejects = cases.filter((r) => r.expected === "grounded" && r.actual !== "grounded");

  // Small evidence is the easy regime; the full-report cases are the realistic one, both
  // for accuracy (more to read past) and for tokens (what the per-minute limit sees).
  const fullReport = cases.filter((r) => r.sections >= 10);
  const fullReportCorrect = fullReport.filter((r) => (r.expected === "grounded") === (r.actual === "grounded"));

  const latency = summarizeLatency(cases.map((r) => r.latencyMs));
  const tokensOf = (rows: JudgeCaseResult[]) => rows.map((r) => r.tokens).filter((t): t is number => t !== null);
  const meanOf = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const tokenCounts = tokensOf(cases);
  const fullReportTokens = meanOf(tokensOf(fullReport));

  const report = [
    heading(`ANSWER CHECK (JUDGE) - ${judgeLabel}`),
    "",
    `Cases: ${cases.length} (` +
      VERDICTS.map((v) => `${cases.filter((c) => c.expected === v).length} ${v}`).join(", ") +
      ").",
    outages.length
      ? "\n" +
        [
          `!! ${outages.length} of ${cases.length} judge calls FAILED after retries and were recorded as`,
          `   fail-open "grounded". Treat every figure below as void - an outage scores as a`,
          `   judge that accepts everything. Usually rate limiting or a bad key.`,
          `   Affected: ${outages.map((r) => r.id).join(", ")}`,
        ].join("\n")
      : "",
    "",
    subheading("Pass / fail (what the route acts on)"),
    formatTable(
      ["metric", "value", "detail"],
      [
        ["judge outages", String(outages.length), outages.length ? "metrics below are void" : "none"],
        ["retries", String(retries.count()), retries.count() ? "latency includes backoff" : "none"],
        ["pass/fail accuracy", pct(passFailCorrect.length / cases.length), `${passFailCorrect.length}/${cases.length}`],
        [
          "  full-report cases",
          fullReport.length ? pct(fullReportCorrect.length / fullReport.length) : "n/a",
          `${fullReportCorrect.length}/${fullReport.length} with the whole report as evidence`,
        ],
        [
          "false accepts (bad passed)",
          String(falseAccepts.length),
          falseAccepts.length ? falseAccepts.map((r) => r.id).join(", ") : "none",
        ],
        [
          "false rejects (good failed)",
          String(falseRejects.length),
          falseRejects.length ? falseRejects.map((r) => r.id).join(", ") : "none",
        ],
      ]
    ),
    "",
    subheading("Three-way verdict"),
    `Accuracy ${pct(confusion.accuracy())}. Partial vs unsupported is a judgement call; weigh it below pass/fail.`,
    formatTable(confusion.toTable().headers, confusion.toTable().rows),
    "",
    subheading("Cost"),
    EVAL_CONCURRENCY > 1 ? `NOTE: run at concurrency ${EVAL_CONCURRENCY}; figures include contention.` : "Serial run.",
    formatTable(
      ["stage", "p50", "p95", "max", "mean"],
      [["judge", ms(latency.p50), ms(latency.p95), ms(latency.max), ms(latency.mean)]]
    ),
    tokenCounts.length
      ? `\nTokens per call: mean ${Math.round(meanOf(tokenCounts))}, max ${Math.max(...tokenCounts)}.` +
        (fullReportTokens
          ? `\nFull-report cases mean ${Math.round(fullReportTokens)}: under an 8K tokens-per-minute limit, ` +
            `~${(8000 / fullReportTokens).toFixed(1)} judge calls/minute.`
          : "")
      : "",
  ].join("\n");

  return { suite: "judge", judge: judgeLabel, concurrency: EVAL_CONCURRENCY, cases, report };
}
