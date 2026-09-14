import { defineConfig } from "vite";

export default defineConfig({
  root: "site",
  appType: "mpa",
  plugins: [{
    name: "admin-workspace-routes",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (/^\/admin\/(?:overview(?:\/surveys\/[^/]+)?|sources|tasks|review(?:\/products\/[^/]+)?|releases)\/?$/.test(pathname)) req.url = "/admin/index.html";
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
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4180",
      "/healthz": "http://127.0.0.1:4180",
    },
  },
});
