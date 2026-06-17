import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [TanStackRouterVite(), react(), tailwindcss()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        // Split the 1MB+ single bundle into stable vendor chunks: the editor
        // stack dwarfs everything else and rarely changes, so parse cost and
        // cache invalidation both drop.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@tiptap") || id.includes("prosemirror")) return "editor";
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) return "react";
          if (id.includes("@tanstack")) return "tanstack";
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
