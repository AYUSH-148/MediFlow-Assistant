/**
 * Bounded-concurrency map, preserving input order in the results.
 *
 * The default is 1, and deliberately so: every suite reports latency percentiles, and
 * running cases in parallel measures contention against the HuggingFace and Gemini
 * endpoints rather than the pipeline's own cost. Raise EVAL_CONCURRENCY when you only
 * care about the accuracy numbers and want the run to finish sooner - the suites print a
 * warning on their latency section when they were run that way.
 */
export const EVAL_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.EVAL_CONCURRENCY ?? "1", 10) || 1
);

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
