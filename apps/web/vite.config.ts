import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const frontendVersion = (process.env.OPERALIBRE_VERSION ?? "dev")
  .trim()
  .replace(/^[vV]/, "");

export default defineConfig({
  // Relative asset URLs let this production bundle run inside the macOS app.
  base: "./",
  define: {
    __OPERALIBRE_FRONTEND_VERSION__: JSON.stringify(frontendVersion)
  },
  plugins: [
    react(),
    {
      name: "operalibre-frontend-version",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "VERSION.txt",
          source: `${frontendVersion}\n`
        });
      }
    }
  ],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        // Browser sessions are cookies, and the server only accepts a
        // cookie-authenticated write whose Origin is its own. Present the
        // proxied request as coming from the server itself, as it would in
        // production where the server serves the app.
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest) => {
            if (proxyRequest.getHeader("origin")) {
              proxyRequest.setHeader("origin", "http://localhost:4000");
            }
            if (proxyRequest.getHeader("referer")) {
              proxyRequest.setHeader("referer", "http://localhost:4000/");
            }
          });
        }
      }
    }
  }
});
