const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_BASE_DELAY_MS = 2000; // 2s, 4s, ... (exponential)
const FETCH_REQUEST_TIMEOUT_MS = 15000; // 15 seconds per request
// Free Clockify workspaces are limited to 30 requests per hour, so after a 429
// we pause all requests for a while instead of retrying (retries burn quota).
const RATE_LIMIT_MIN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Thrown when the API told us to slow down (HTTP 429) or while we are still
 * in the cooldown period after such a response. Callers can use this to fall
 * back to cached data instead of hammering the API.
 */
export class RateLimitError extends Error {
  constructor(public readonly retryAt: number) {
    super(`Clockify rate limit reached. Retrying after ${new Date(retryAt).toLocaleTimeString()}.`);
    this.name = "RateLimitError";
  }
}

// Shared across all requests: once Clockify answers 429 we stop sending any
// request until this timestamp has passed.
let rateLimitedUntil = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a Retry-After header (seconds or HTTP date) into milliseconds.
 */
const parseRetryAfter = (response: Response): number | null => {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
};

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

/**
 * Fetch with timeout, exponential backoff and rate-limit awareness.
 *
 * - Client errors (4xx except 429) are returned immediately so callers can
 *   surface the error message — retrying them only burns API quota.
 * - 429 responses are not retried; instead all further requests are put on
 *   hold for a cooldown period (honoring Retry-After).
 * - 5xx and network errors are retried with exponential backoff.
 */
export const fetchWithRetry = async (url: string, options: RequestInit): Promise<Response> => {
  if (Date.now() < rateLimitedUntil) {
    throw new RateLimitError(rateLimitedUntil);
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt += 1) {
    const isLastAttempt = attempt === FETCH_MAX_ATTEMPTS - 1;
    const retryDelay = FETCH_RETRY_BASE_DELAY_MS * 2 ** attempt;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), FETCH_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });

      if (!isRetryableStatus(response.status)) {
        return response;
      }

      if (response.status === 429) {
        const cooldown = Math.min(
          Math.max(parseRetryAfter(response) ?? 0, RATE_LIMIT_MIN_COOLDOWN_MS),
          RATE_LIMIT_MAX_COOLDOWN_MS,
        );
        rateLimitedUntil = Date.now() + cooldown;
        throw new RateLimitError(rateLimitedUntil);
      }
      if (isLastAttempt) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (err) {
      if (err instanceof RateLimitError || isLastAttempt) {
        throw err;
      }
      lastError = err;
    } finally {
      clearTimeout(timeoutHandle);
    }

    await sleep(retryDelay);
  }

  throw new Error(
    `Failed to fetch ${url} after ${FETCH_MAX_ATTEMPTS} attempts: ${String(lastError)}`,
  );
};
