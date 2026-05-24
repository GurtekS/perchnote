import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@tauri-apps/api/core": resolve(
        __dirname,
        "src/__mocks__/@tauri-apps/api/core.ts"
      ),
      "@tauri-apps/api/event": resolve(
        __dirname,
        "src/__mocks__/@tauri-apps/api/event.ts"
      ),
      "@tauri-apps/plugin-shell": resolve(
        __dirname,
        "src/__mocks__/@tauri-apps/plugin-shell/index.ts"
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
});
