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
      "/api": "http://localhost:4000"
    }
  }
});
