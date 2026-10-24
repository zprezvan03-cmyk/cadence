import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST || "0.0.0.0";

export default defineConfig({
  root: resolve("src/renderer"),
  // Relative asset URLs so the built renderer works under Tauri custom protocols and HTTP test servers.
  base: "./",
  clearScreen: false,
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    host,
    allowedHosts: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  preview: {
    port: 1420,
    strictPort: true,
    host,
    allowedHosts: true,
  },
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@renderer": resolve("src/renderer"),
      "@upstream": resolve("src/renderer/upstream"),
    },
  },
  build: {
    outDir: resolve("dist"),
    emptyOutDir: true,
    assetsDir: "assets",
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "es2022",
    rollupOptions: {
      input: { index: resolve("src/renderer/index.html") },
    },
  },
});
