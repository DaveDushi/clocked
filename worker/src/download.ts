export const DOWNLOAD_URL =
  "https://github.com/DaveDushi/clocked/releases/latest/download/clocked-setup-0.1.0.exe";

export function downloadResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: DOWNLOAD_URL,
      "cache-control": "no-store",
    },
  });
}
