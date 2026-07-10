import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset URLs let this production bundle run inside the macOS app.
  base: "./",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:4000"
    }
  }
});
