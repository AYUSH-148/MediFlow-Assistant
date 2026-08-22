import {
  cacheResponse,
  clearCacheForReport,
  cosineSimilarity,
  getCachedResponse,
} from "@/lib/cache";
import { generateEmbedding } from "@/lib/embeddings";
import { findIngested, loadCorpus } from "../lib/corpus";
import { CACHE_PAIRS, type CachePair } from "../dataset/cache";
import { EVAL_CONCURRENCY, mapWithConcurrency } from "../lib/concurrency";
import { createRetryCounter, withRetry } from "../lib/retry";
import { formatTable, heading, mean, ms, pct, subheading, summarizeLatency } from "../lib/metrics";

/** The threshold the chat route passes to getCachedResponse today. */
const PRODUCTION_THRESHOLD = 0.95;

const SWEEP = [0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99];

/** How many entries to preload when measuring how lookup cost scales with cache size. */
const SCALING_STEPS = [1, 5, 10, 25];

export interface CachePairResult {
  id: string;
  reportId: string;
  seed: string;
  probe: string;
  relation: "paraphrase" | "distinct";
  similarity: number;
  /** What getCachedResponse actually did at the production threshold. */
  hit: boolean;
  correct: boolean;
  lookupMs: number;
}

export interface CacheSuiteResult {
  suite: "cache";
  concurrency: number;
  cases: CachePairResult[];
  scaling: Array<{ entries: number; lookupMs: number }>;
  report: string;
}

async function runPair(
  pair: CachePair,
  reportData: string,
  onRetry: (attempt: number, error: unknown) => void
): Promise<CachePairResult> {
  // Entries are keyed by a hash of the report text, so every pair on the same fixture
  // shares one namespace. Clearing first means each pair sees exactly one candidate and
  // the measured hit is attributable to this pair rather than to a leftover from an
  // earlier one.
  await clearCacheForReport(reportData);
  await cacheResponse(pair.seed, `Cached answer for: ${pair.seed}`, reportData);

  const start = performance.now();
  const cached = await getCachedResponse(pair.probe, reportData, PRODUCTION_THRESHOLD);
  const lookupMs = performance.now() - start;

  // Measured independently of the lookup above so the sweep has a similarity for every
  // pair, including ones the cache reported as a miss.
  const seedVector = await withRetry(() => generateEmbedding(pair.seed), { onRetry });
  const probeVector = await withRetry(() => generateEmbedding(pair.probe), { onRetry });
  const similarity = cosineSimilarity(seedVector, probeVector);

  const hit = cached !== null;
  const shouldHit = pair.relation === "paraphrase";

  await clearCacheForReport(reportData);

  return {
    id: pair.id,
    reportId: pair.reportId,
    seed: pair.seed,
    probe: pair.probe,
    relation: pair.relation,
    similarity,
    hit,
    correct: hit === shouldHit,
    lookupMs,
  };
}

/**
 * getCachedResponse fetches every key under the report prefix with `redis.keys()` and
 * then `mget`s all of them, comparing in process. That is linear in the number of cached
 * questions for the report, and the 24h TTL means a heavily used report accumulates
 * entries all day - so how the lookup scales is a real operational number, not a
 * hypothetical.
 */
async function measureScaling(reportData: string, log: (line: string) => void): Promise<Array<{ entries: number; lookupMs: number }>> {
  await clearCacheForReport(reportData);
  const measurements: Array<{ entries: number; lookupMs: number }> = [];
  let seeded = 0;

  for (const target of SCALING_STEPS) {
    while (seeded < target) {
      seeded += 1;
      await cacheResponse(
        `Filler question number ${seeded} about an unrelated biomarker in this report`,
        `Filler answer ${seeded}`,
        reportData
      );
    }

    // A question with no near neighbour, so the lookup always scans every entry rather
    // than short-circuiting on an early match - the worst case, and the one that matters.
    const start = performance.now();
    await getCachedResponse(
      "What is the collection date printed at the top of this report?",
      reportData,
      PRODUCTION_THRESHOLD
    );
    const lookupMs = performance.now() - start;

    measurements.push({ entries: seeded, lookupMs });
    log(`  cache scaling: ${String(seeded).padStart(3)} entries -> ${ms(lookupMs)} (full scan)`);
  }

  await clearCacheForReport(reportData);
  return measurements;
}

export async function runCacheSuite(
  log: (line: string) => void = console.log
): Promise<CacheSuiteResult> {
  const manifest = loadCorpus();

  log(`Running ${CACHE_PAIRS.length} cache pairs (concurrency 1 - pairs share Redis namespaces)...`);

  // Forced serial regardless of EVAL_CONCURRENCY: pairs on the same report write to the
  // same key prefix and clear it, so running two at once would have them delete each
  // other's entries and report meaningless misses.
  const retries = createRetryCounter();
  const cases = await mapWithConcurrency(CACHE_PAIRS, 1, async (pair, index) => {
    const ingested = findIngested(manifest, pair.reportId);
    const result = await runPair(pair, ingested.redactedSummary, retries.onRetry);
    log(
      `  [${String(index + 1).padStart(2)}/${CACHE_PAIRS.length}] ${pair.id.padEnd(26)} ` +
        `sim=${result.similarity.toFixed(4)} ${result.hit ? "HIT " : "miss"} ` +
        `${result.correct ? "ok" : "WRONG"}`
    );
    return result;
  });

  log("Measuring how lookup cost scales with cached entries per report...");
  const scaling = await measureScaling(findIngested(manifest, CACHE_PAIRS[0].reportId).redactedSummary, log);

  const paraphrases = cases.filter((c) => c.relation === "paraphrase");
  const distincts = cases.filter((c) => c.relation === "distinct");

  const truePositives = paraphrases.filter((c) => c.hit);
  const falsePositives = distincts.filter((c) => c.hit);

  const latency = summarizeLatency(cases.map((c) => c.lookupMs));

  // Sweep the threshold over the measured similarities. This is the number the current
  // 0.95 was never chosen against: it shows how much headroom, if any, separates the two
  // populations.
  const sweepRows = SWEEP.map((threshold) => {
    const caught = paraphrases.filter((c) => c.similarity >= threshold).length;
    const wrong = distincts.filter((c) => c.similarity >= threshold).length;
    return [
      threshold === PRODUCTION_THRESHOLD ? `${threshold.toFixed(2)} <- current` : threshold.toFixed(2),
      `${caught}/${paraphrases.length}`,
      pct(caught / Math.max(paraphrases.length, 1), 0),
      `${wrong}/${distincts.length}`,
      pct(wrong / Math.max(distincts.length, 1), 0),
    ];
  });

  // The most permissive threshold that still lets no distinct pair through. Reported as
  // an observation about this gold set, not as a recommendation - 20 pairs is not enough
  // to tune a production threshold on.
  const safest = [...SWEEP]
    .sort((a, b) => a - b)
    .find((threshold) => distincts.every((c) => c.similarity < threshold));
  const caughtAtSafest = safest
    ? paraphrases.filter((c) => c.similarity >= safest).length
    : 0;

  // Self-check on the measurement itself. getCachedResponse swallows Redis and embedding
  // failures and returns null, which is indistinguishable from a genuine miss - so a run
  // degraded by infrastructure would quietly report a low paraphrase hit rate as if it
  // were a threshold finding. Recomputing the similarity here gives an independent
  // prediction of what the lookup should have done; any disagreement means the observed
  // hit rate below is not measuring what it claims to.
  const anomalies = cases.filter((c) => (c.similarity >= PRODUCTION_THRESHOLD) !== c.hit);

  const separation = {
    paraphraseMin: paraphrases.length ? Math.min(...paraphrases.map((c) => c.similarity)) : 0,
    paraphraseMean: mean(paraphrases.map((c) => c.similarity)),
    distinctMax: distincts.length ? Math.max(...distincts.map((c) => c.similarity)) : 0,
    distinctMean: mean(distincts.map((c) => c.similarity)),
  };

  const report = [
    heading("SEMANTIC RESPONSE CACHE"),
    "",
    `Pairs: ${CACHE_PAIRS.length} (${paraphrases.length} paraphrase, ${distincts.length} distinct). ` +
      `Threshold under test: ${PRODUCTION_THRESHOLD}.`,
    "",
    subheading("Behaviour at the production threshold"),
    formatTable(
      ["metric", "value", "detail"],
      [
        [
          "paraphrase hit rate",
          paraphrases.length ? pct(truePositives.length / paraphrases.length) : "n/a",
          `${truePositives.length}/${paraphrases.length} reworded questions served from cache`,
        ],
        [
          "false hit rate",
          distincts.length ? pct(falsePositives.length / distincts.length) : "n/a",
          falsePositives.length
            ? `WRONG ANSWER REPLAYED: ${falsePositives.map((c) => c.id).join(", ")}`
            : `0/${distincts.length} - no distinct question served another's answer`,
        ],
        [
          "overall correct",
          pct(cases.filter((c) => c.correct).length / cases.length),
          `${cases.filter((c) => c.correct).length}/${cases.length}`,
        ],
        [
          "measurement self-check",
          anomalies.length === 0 ? "consistent" : `${anomalies.length} ANOMALIES`,
          anomalies.length === 0
            ? "every lookup matched its independently recomputed similarity"
            : `lookup disagreed with recomputed similarity (swallowed error?): ${anomalies.map((c) => c.id).join(", ")}`,
        ],
        [
          "retries during run",
          String(retries.count()),
          "transient embedding failures re-attempted",
        ],
      ]
    ),
    "",
    subheading("Similarity separation"),
    formatTable(
      ["population", "mean", "boundary"],
      [
        ["paraphrase", separation.paraphraseMean.toFixed(4), `min ${separation.paraphraseMin.toFixed(4)}`],
        ["distinct", separation.distinctMean.toFixed(4), `max ${separation.distinctMax.toFixed(4)}`],
      ]
    ),
    separation.paraphraseMin > separation.distinctMax
      ? `The two populations do not overlap: any threshold in ` +
        `(${separation.distinctMax.toFixed(4)}, ${separation.paraphraseMin.toFixed(4)}] separates them cleanly on this set.`
      : `The populations OVERLAP - the closest distinct pair scores ${separation.distinctMax.toFixed(4)} ` +
        `while the loosest paraphrase scores ${separation.paraphraseMin.toFixed(4)}. No single threshold ` +
        `can get both right on this set.`,
    "",
    subheading("Threshold sweep"),
    formatTable(
      ["threshold", "paraphrases caught", "hit rate", "distinct leaked", "false hit rate"],
      sweepRows
    ),
    safest
      ? `\nMost permissive threshold with zero false hits on this set: ${safest.toFixed(2)} ` +
        `(catches ${caughtAtSafest}/${paraphrases.length} paraphrases, against ` +
        `${truePositives.length}/${paraphrases.length} at the current ${PRODUCTION_THRESHOLD}).`
      : `\nNo swept threshold achieves zero false hits on this set.`,
    "",
    subheading("Lookup latency"),
    formatTable(
      ["metric", "p50", "p95", "max", "mean"],
      [["cache lookup (embed + scan)", ms(latency.p50), ms(latency.p95), ms(latency.max), ms(latency.mean)]]
    ),
    "",
    "Lookup cost against a growing cache for a single report (full scan, no early match):",
    formatTable(
      ["entries under report", "lookup"],
      scaling.map((step) => [String(step.entries), ms(step.lookupMs)])
    ),
    "",
    "getCachedResponse KEYS + MGETs every entry for the report and compares in process,",
    "so this grows linearly. Entries live for 24h, so a heavily used report accumulates",
    "them all day.",
  ].join("\n");

  return { suite: "cache", concurrency: EVAL_CONCURRENCY, cases, scaling, report };
}
