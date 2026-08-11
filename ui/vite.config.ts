import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = dirname(fileURLToPath(import.meta.url));

// Root is pinned to this directory because the build is invoked from the repo
// root, where Vite would otherwise look for index.html and find nothing.
// Output goes to ../web, which wrangler serves as static assets at zero
// compute cost; the Worker only ever handles /api/*.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(here, "../web"), emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
