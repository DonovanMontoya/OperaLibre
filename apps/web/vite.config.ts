import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { devProxyTarget } from "../../script/dev_proxy.mjs";

const frontendVersion = (process.env.OPERALIBRE_VERSION ?? "dev")
  .trim()
  .replace(/^[vV]/, "");

export default defineConfig(({ command }) => {
  const proxyTarget = command === "serve" ? devProxyTarget() : undefined;
  // Set by `npm run testenv` to sign every request in as a test account
  // instead of the browser's own session.
  const sessionToken = command === "serve" ? process.env.OPERALIBRE_DEV_SESSION_TOKEN : undefined;
  return {
    // Relative asset URLs let this production bundle run inside the macOS app.
    base: "./",
    define: {
      __OPERALIBRE_FRONTEND_VERSION__: JSON.stringify(frontendVersion),
      // Lets the browser recognize a saved server address as this same
      // proxied backend even when server.config sets a custom port. URL
      // elides the default http port (80), so recover it explicitly —
      // devProxyTarget always returns an http:// target.
      __OPERALIBRE_DEV_PROXY_PORT__: JSON.stringify(proxyTarget ? new URL(proxyTarget).port || "80" : "")
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
      },
      ...(sessionToken ? [{
        name: "operalibre-testenv-session",
        configureServer(server: ViteDevServer) {
          // Signing out would end the shared test session, so it does nothing.
          server.middlewares.use("/api/auth/logout", (_request, response) => {
            response.statusCode = 204;
            response.end();
          });
        }
      }] : [])
    ],
    server: {
      proxy: {
        "/api": {
          target: proxyTarget,
          // Browser sessions are cookies, and the server only accepts a
          // cookie-authenticated write whose Origin is its own. Present the
          // proxied request as coming from the server itself, as it would in
          // production where the server serves the app.
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest) => {
              if (proxyRequest.getHeader("origin")) {
                proxyRequest.setHeader("origin", proxyTarget!);
              }
              if (proxyRequest.getHeader("referer")) {
                proxyRequest.setHeader("referer", `${proxyTarget}/`);
              }
              if (sessionToken) {
                proxyRequest.removeHeader("cookie");
                proxyRequest.setHeader("authorization", `Bearer ${sessionToken}`);
              }
            });
          }
        }
      }
    }
  };
});
