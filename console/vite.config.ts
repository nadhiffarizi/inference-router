import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Dev proxy: /v1/* → the gateway, so the console is same-origin in dev too. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
  build: { outDir: "dist" },
});