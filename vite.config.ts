import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const releaseId = process.env.RELEASE_ID || process.env.GITHUB_SHA || String(Date.now());

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || "/",
  define: {
    __APP_RELEASE_ID__: JSON.stringify(releaseId)
  },
  server: {
    port: 5173
  }
});
