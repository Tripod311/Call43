import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "client"),
  build: {
    outDir: resolve(import.meta.dirname, "client_dist"),
    emptyOutDir: true,
  },
});