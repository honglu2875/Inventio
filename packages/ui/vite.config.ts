import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Dev/preview proxy. Override when the conductor uses a custom port:
 * `INVENTIO_API_TARGET=http://127.0.0.1:4800 npm run dev:ui`.
 * SSE routes must not be buffered — http-proxy streams them through as-is.
 */
const apiTarget = process.env["INVENTIO_API_TARGET"] ?? "http://127.0.0.1:4700";
const proxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: false,
    ws: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { outDir: "dist", sourcemap: true },
  // The workspace schema package ships TypeScript sources; keep it out of the
  // dep pre-bundler so Vite transforms it through the normal pipeline.
  optimizeDeps: { exclude: ["@inventio/schema"] },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
