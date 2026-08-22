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
 */
export interface RetryStats {
  attempts: number;
  retries: number;
}

const RETRYABLE = /429|5\d\d|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|an HTTP error occurred/i;

export async function withRetry<T>(
  operation: () => Promise<T>,
  {
    attempts = 4,
    baseDelayMs = 1500,
    label = "operation",
    onRetry,
  }: {
    attempts?: number;
    baseDelayMs?: number;
    label?: string;
    onRetry?: (attempt: number, error: unknown) => void;
  } = {}
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      // A schema violation or a bad request will fail identically every time; retrying it
      // just multiplies the wait before the run reports the real problem.
      if (attempt === attempts || !RETRYABLE.test(message)) throw error;

      onRetry?.(attempt, error);
      // Exponential with jitter, so a suite that hits a rate limit does not resume in
      // lockstep and immediately hit it again.
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 500;
      await new Promise((done) => setTimeout(done, delay));
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
