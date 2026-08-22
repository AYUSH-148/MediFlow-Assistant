import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, requireEnv } from "./lib/env";

// Same ordering constraint as build.ts: env first, suites by dynamic import after.
const envFiles = loadEnv();

const SUITES = ["retrieval", "guard", "cache"] as const;
type SuiteName = (typeof SUITES)[number];

// Only the keys each suite actually reaches for, so a run of one suite is not blocked by
// a credential it will never use.
const REQUIRED_ENV: Record<SuiteName, string[]> = {
  retrieval: ["PINECONE_API_KEY", "HF_TOKEN", "GEMINI_API_KEY"],
  guard: ["GEMINI_API_KEY"],
  cache: ["PINECONE_API_KEY", "HF_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
};

function parseSuites(argv: string[]): SuiteName[] {
  const requested = argv.filter((arg) => !arg.startsWith("-"));
  if (requested.length === 0 || requested.includes("all")) return [...SUITES];

  const unknown = requested.filter((name) => !SUITES.includes(name as SuiteName));
  if (unknown.length > 0) {
    throw new Error(`Unknown suite(s): ${unknown.join(", ")}. Choose from: ${SUITES.join(", ")}, all.`);
  }

  return requested as SuiteName[];
}

async function main(): Promise<void> {
  const suites = parseSuites(process.argv.slice(2));
  requireEnv(Array.from(new Set(suites.flatMap((suite) => REQUIRED_ENV[suite]))));

  const { TRACING_ENABLED, TRACE_PHI, flushTraces } = await import("@/lib/tracing");
  const { GEMINI_MODEL_ID } = await import("@/lib/gemini");
  const { EMBEDDING_MODEL_ID } = await import("@/lib/embeddings");
  const { EVAL_INDEX, EVAL_NAMESPACE } = await import("./lib/corpus");
  const { EVAL_CONCURRENCY } = await import("./lib/concurrency");

  console.log(`Environment: ${envFiles.length ? envFiles.join(", ") : "(process only)"}`);
  console.log(`Suites:      ${suites.join(", ")}`);
  console.log(`Models:      ${GEMINI_MODEL_ID} (generation/grading), ${EMBEDDING_MODEL_ID} (embeddings)`);
  console.log(`Pinecone:    index "${EVAL_INDEX}", namespace "${EVAL_NAMESPACE}"`);
  console.log(`Concurrency: ${EVAL_CONCURRENCY}`);
  // Tracing adds a network round trip per span. It is useful to have on, but it inflates
  // every latency figure below, so the run states which mode produced its numbers.
  console.log(
    `Tracing:     ${TRACING_ENABLED ? `ON (PHI capture ${TRACE_PHI ? "ON" : "off"}) - latency figures include span uploads` : "off"}`
  );

  const started = Date.now();
  const results: Record<string, unknown> = {};
  const reports: string[] = [];

  for (const suite of suites) {
    if (suite === "retrieval") {
      const { runRetrievalSuite } = await import("./suites/retrieval");
      const result = await runRetrievalSuite();
      results.retrieval = result;
      reports.push(result.report);
    } else if (suite === "guard") {
      const { runGuardSuite } = await import("./suites/guard");
      const result = await runGuardSuite();
      results.guard = result;
      reports.push(result.report);
    } else {
      const { runCacheSuite } = await import("./suites/cache");
      const result = await runCacheSuite();
      results.cache = result;
      reports.push(result.report);
    }
  }

  // Spans opened by the suites batch in the background; without this the process can exit
  // before the last batch is sent.
  await flushTraces();

  console.log(reports.join("\n"));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nCompleted ${suites.length} suite(s) in ${elapsed}s.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = resolve(process.cwd(), "eval/results");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, `${stamp}.json`);

  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        startedAt: new Date(started).toISOString(),
        elapsedSeconds: Number(elapsed),
        suites,
        environment: {
          geminiModel: GEMINI_MODEL_ID,
          embeddingModel: EMBEDDING_MODEL_ID,
          pineconeIndex: EVAL_INDEX,
          pineconeNamespace: EVAL_NAMESPACE,
          concurrency: EVAL_CONCURRENCY,
          tracingEnabled: TRACING_ENABLED,
        },
        results,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`Per-case results written to ${outputPath}`);
}

main().catch((error) => {
  console.error(`\nEval failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
