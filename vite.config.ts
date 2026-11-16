import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: {
      "@tauri-apps/api/core": path.resolve(__dirname, "src/tauri-compat/core.ts"),
      "@tauri-apps/api/event": path.resolve(__dirname, "src/tauri-compat/event.ts"),
      "@tauri-apps/api/webview": path.resolve(__dirname, "src/tauri-compat/webview.ts"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_ENV_*", "TAURI_"],
  build: {
    target: ["es2020", "chrome86", "safari13"],
    minify: !process.env.TAURI_ENV_DEBUG && !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!(process.env.TAURI_ENV_DEBUG || process.env.TAURI_DEBUG),
  },
});
