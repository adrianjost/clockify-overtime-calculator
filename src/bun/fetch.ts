const FETCH_MAX_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 1000;
const FETCH_REQUEST_TIMEOUT_MS = 15000; // 15 seconds per request

export const fetchWithRetry = async (url: string, options: RequestInit): Promise<Response> => {
  let response: Response | undefined;

  for (let attempt = 0; attempt < FETCH_MAX_RETRIES; attempt += 1) {
    try {
      // Add timeout to prevent hanging
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), FETCH_REQUEST_TIMEOUT_MS);

      response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutHandle);

      if (response.ok) {
        return response;
      }
    } catch (err) {
      if (attempt < FETCH_MAX_RETRIES - 1) {
        // Retry on failure
      } else {
        throw err;
      }
    }

    // Wait before retrying (except after the last attempt)
    if (attempt < FETCH_MAX_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
    }
  }

  throw new Error(
    `Failed to fetch ${url} after ${FETCH_MAX_RETRIES} attempts. Last error: ${response?.statusText || "Network error"}`,
  );
};
