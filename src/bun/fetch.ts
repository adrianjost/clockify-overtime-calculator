export const fetchWithRetry = async (
  url: string,
  options: RequestInit,
): Promise<Response> => {
  let response: Response | undefined;
  for (let i = 0; i < 3; i += 1) {
    response = await fetch(url, options);
    if (response.ok) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (response === undefined) {
    throw new Error("Failed to fetch data");
  }
  return response;
};
