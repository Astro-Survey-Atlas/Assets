import { defineConfig } from "vite";

export default defineConfig({
  root: "site",
  build: {
    outDir: "../dist/site",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4180",
      "/healthz": "http://127.0.0.1:4180",
    },
  },
});

