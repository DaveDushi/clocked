import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// Worker-only project: the plugin reads bindings + `main` from wrangler.jsonc.
// Dev port is hard-coded (Vite defaults to 5173) so it matches BETTER_AUTH_URL.
export default defineConfig({
  plugins: [cloudflare()],
  server: {
    port: 8787,
    strictPort: true, // fail loudly instead of auto-incrementing the port
    // Listen on all interfaces (IPv4 127.0.0.1, IPv6 ::1, and LAN). Dev-only:
    // lets the desktop tray app reach the worker over 127.0.0.1/localhost.
    host: true,
  },
});
