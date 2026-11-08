import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The built app is served by the API Worker under /app (README.md, "Serving").
// In dev the app runs at the root of the Vite server and /v1 is proxied to
// `wrangler dev`, so cookies and the Origin check behave like production.
const API_DEV = "http://localhost:8787";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/app/" : "/",
  plugins: [react()],
  build: {
    outDir: "../../services/api/public/app",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/v1": { target: API_DEV, changeOrigin: false } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
}));
