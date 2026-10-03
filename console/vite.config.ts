import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Dev proxy: /v1/* → the gateway, so the console is same-origin in dev too. */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
  build: { outDir: "dist" },
});