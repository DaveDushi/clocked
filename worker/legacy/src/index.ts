const DESTINATION = "https://clocked.easytomanage.com";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const destination = new URL(url.pathname + url.search, DESTINATION);
    if ((request.method === "GET" || request.method === "HEAD")
      && !url.pathname.startsWith("/api/")
      && !url.pathname.startsWith("/desktop/")
      && url.pathname !== "/health") {
      return Response.redirect(destination.toString(), 308);
    }
    return fetch(new Request(destination, request), { redirect: "manual" });
  },
};
