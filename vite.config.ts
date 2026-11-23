import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "vite";

const swaggerBundlePath = createRequire(import.meta.url).resolve("swagger-ui-dist/swagger-ui-bundle.js");

export default defineConfig({
  root: "site",
  appType: "mpa",
  plugins: [{
    // Swagger's UMD bundle is shipped as a plain script: bundling it drags CJS helpers into the atlas
    // entry chunk, which then executes on /api-docs and throws "Missing element".
    name: "swagger-ui-static",
    configureServer(server) {
      server.middlewares.use("/vendor/swagger-ui-bundle.js", (_req, res) => { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(swaggerBundlePath)); });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "vendor/swagger-ui-bundle.js", source: readFileSync(swaggerBundlePath) });
    },
  }, {
    name: "admin-workspace-routes",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (/^\/admin\/(?:overview(?:\/surveys\/[^/]+)?|sources|tasks|review(?:\/products\/[^/]+)?|releases|api|ops)\/?$/.test(pathname)) req.url = "/admin/index.html";
        next();
      });
    },
  }],
  build: {
    outDir: "../dist/site",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: "index.html",
        admin: "admin/index.html",
        atlas: "atlas/index.html",
        github: "github/index.html",
        surveys: "surveys/index.html",
        releases: "releases/index.html",
        sdk: "sdk/index.html",
        terms: "terms/index.html",
        apiDocs: "api-docs/index.html",
      },
    },
  },
  server: {
    proxy: {
      "/api/": "http://127.0.0.1:4180",
      "/healthz": "http://127.0.0.1:4180",
    },
  },
});
