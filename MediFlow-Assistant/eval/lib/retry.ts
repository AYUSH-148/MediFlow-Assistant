/**
 * Retry with exponential backoff.
 *
 * The HuggingFace inference endpoint and the Gemini API both fail transiently under the
 * request rate a full suite generates - HTTP 429s and 5xxs that succeed on a second
 * attempt seconds later. Without this, one such blip aborts the run partway through and
 * the operator sees a crash rather than a result set.
 *
 * Retries are counted and surfaced by the caller rather than hidden: a suite that needed
 * fifteen retries to complete produced its latency figures under conditions worth
 * knowing about.
 *
 * Not every transient failure arrives as a thrown error. A component that fails open -
 * the query guard degrades to `intent: "answer"` with `guardFailed: true` rather than
 * throwing - resolves successfully while reporting that it never really ran. `retryResult`
 * lets a caller retry on that too, so the same backoff covers both shapes instead of a
 * suite growing its own copy.
 */
export interface RetryStats {
  attempts: number;
  retries: number;
}

const RETRYABLE = /429|5\d\d|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|an HTTP error occurred/i;

// Exponential with jitter, so a suite that hits a rate limit does not resume in lockstep
// and immediately hit it again.
function sleep(baseDelayMs: number, attempt: number): Promise<void> {
  const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 500;
  return new Promise((done) => setTimeout(done, delay));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  {
    attempts = 4,
    baseDelayMs = 1500,
    label = "operation",
    onRetry,
    retryResult,
  }: {
    attempts?: number;
    baseDelayMs?: number;
    label?: string;
    onRetry?: (attempt: number, error: unknown) => void;
    /**
     * Retry a resolved value. Return true when the result means "this did not really
     * run" - a fail-open degradation rather than a decision. The last attempt's value is
     * returned regardless, so a caller still gets a result to record and report.
     */
    retryResult?: (value: T) => boolean;
  } = {}
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await operation();
      if (attempt === attempts || !retryResult?.(value)) return value;

      onRetry?.(attempt, new Error(`${label} failed open; retrying`));
      await sleep(baseDelayMs, attempt);
      continue;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      // A schema violation or a bad request will fail identically every time; retrying it
      // just multiplies the wait before the run reports the real problem.
      if (attempt === attempts || !RETRYABLE.test(message)) throw error;

      onRetry?.(attempt, error);
      await sleep(baseDelayMs, attempt);
    }
  }

  throw lastError;
}

/** Mutable counter a suite can thread through its cases to report total retries. */
export function createRetryCounter() {
  let retries = 0;
  return {
    count: () => retries,
    onRetry: (attempt: number, error: unknown) => {
      retries += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`    retry ${attempt}: ${message.slice(0, 120)}`);
    },
  };
}
