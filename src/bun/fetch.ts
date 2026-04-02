const FETCH_MAX_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 1000;

export const fetchWithRetry = async (url: string, options: RequestInit): Promise<Response> => {
  let response: Response | undefined;

  for (let attempt = 0; attempt < FETCH_MAX_RETRIES; attempt += 1) {
    try {
      response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
    } catch (err) {
      if (attempt < FETCH_MAX_RETRIES - 1) {
        // Log retries but not the last failure, as it will throw below
        console.warn(`Fetch attempt ${attempt + 1} failed, retrying...`, err);
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
