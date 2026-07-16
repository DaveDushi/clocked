// Installer / extension download redirects. Assets live on the GitHub "latest
// release" and use stable filenames so these URLs never need a version bump.
export const DOWNLOAD_URL_WIN =
  "https://github.com/DaveDushi/clocked/releases/latest/download/clocked-setup.exe";
export const DOWNLOAD_URL_MAC =
  "https://github.com/DaveDushi/clocked/releases/latest/download/clocked-setup.dmg";
/** Chrome/Edge extension zip (load unpacked after unzip). */
export const DOWNLOAD_URL_EXTENSION =
  "https://github.com/DaveDushi/clocked/releases/latest/download/clocked-chrome.zip";

// Back-compat: existing callers/links import DOWNLOAD_URL for the Windows installer.
export const DOWNLOAD_URL = DOWNLOAD_URL_WIN;

export function isDownloadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

/** True for macOS desktop browsers (excludes iPhone/iPad, which can't run the app). */
function isMac(userAgent: string | null): boolean {
  const ua = userAgent ?? "";
  return /Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua);
}

/** `/download` — pick the installer for the visitor's OS (macOS → dmg, else Windows exe). */
export function downloadResponse(userAgent: string | null): Response {
  return redirect(isMac(userAgent) ? DOWNLOAD_URL_MAC : DOWNLOAD_URL_WIN);
}

/** `/download/mac` — always the macOS disk image. */
export function downloadMacResponse(): Response {
  return redirect(DOWNLOAD_URL_MAC);
}

/** `/download/win` — always the Windows installer. */
export function downloadWinResponse(): Response {
  return redirect(DOWNLOAD_URL_WIN);
}

/** `/download/extension` (and `/download/chrome`) — Chrome/Edge extension zip. */
export function downloadExtensionResponse(): Response {
  return redirect(DOWNLOAD_URL_EXTENSION);
}
