import path from "path";
import { defineConfig } from "vitest/config";

// Standalone from vite.config.ts on purpose - that file's dev-server config (fixed port,
// Tauri host/HMR settings) is irrelevant to running unit tests and would just add noise/
// potential conflicts here.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
