export const DOWNLOAD_URL =
  "https://github.com/DaveDushi/clocked/releases/latest/download/clocked-setup.exe";

export function isDownloadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export function downloadResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: DOWNLOAD_URL,
      "cache-control": "no-store",
    },
  });
}
