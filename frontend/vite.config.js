import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Serve IDKit's WASM from its real location during dev.
 *
 * IDKit references it as `new URL("idkit_wasm_bg.wasm", import.meta.url)`. Vite's
 * dep optimiser pre-bundles the JS into node_modules/.vite/deps/ but does not
 * copy that sibling .wasm, so the URL resolves into the deps directory and misses.
 * The request then hits the SPA fallback and the browser receives index.html,
 * which it tries to instantiate as WebAssembly — surfacing as IDKit's generic
 * "Something went wrong" with a request that looks like a clean 200/304.
 *
 * Excluding IDKit from pre-bundling also fixes the path, but stops Vite doing
 * CommonJS interop for its CJS dependencies (`qrcode` has no ESM default export),
 * which breaks module loading instead. So: keep pre-bundling, and just answer the
 * one request the optimiser cannot.
 *
 * Dev-only. The production build already emits a hashed .wasm, because Rollup
 * understands the `new URL(..., import.meta.url)` asset pattern.
 */
function idkitWasm() {
  return {
    name: "idkit-wasm-dev",
    apply: "serve",
    configureServer(server) {
      // Resolved as a plain path, not via require.resolve: the package's
      // `exports` map does not expose the .wasm subpath, so resolution throws.
      const wasmPath = fileURLToPath(
        new URL("node_modules/@worldcoin/idkit-core/dist/idkit_wasm_bg.wasm", import.meta.url),
      );
      if (!existsSync(wasmPath)) {
        // Loud, because the silent version of this failure is a 200 of index.html
        // that the browser tries to run as WebAssembly.
        throw new Error(`idkit-wasm-dev: expected IDKit wasm at ${wasmPath}`);
      }
      server.middlewares.use((req, res, next) => {
        if (!req.url?.includes("idkit_wasm_bg.wasm")) return next();
        res.setHeader("Content-Type", "application/wasm");
        res.setHeader("Cache-Control", "no-cache");
        res.end(readFileSync(wasmPath));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), idkitWasm()],

  server: {
    port: 5173,
    // In production the SPA and /api/* are one CloudFront origin, so there is no
    // CORS. The dev server proxies /api to preserve that — the app's fetch path is
    // byte-identical in both environments.
    //
    // Defaults to the DEPLOYED endpoint. That exercises the real Lambda,
    // CloudFront behaviour and Secrets Manager path, so the demo is testing what
    // it will actually present — and it needs no signing key on this machine.
    // `changeOrigin` rewrites Host to scubaswap.xyz, which CloudFront requires.
    //
    // Override for a local backend: RP_API=http://127.0.0.1:8787 npm run dev
    proxy: {
      "/api": { target: process.env.RP_API ?? "https://scubaswap.xyz", changeOrigin: true },
    },
  },
});
