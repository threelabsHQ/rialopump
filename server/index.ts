/**
 * server/index.ts — local development entry point
 * Runs the Hono app via @hono/node-server (full Node.js HTTP server).
 * In production the CF Worker (worker.ts) calls app.fetch() directly.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, FsKV } from "./app.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "../dist");

// Local dev uses fs-backed KV (server/tokens.json)
const kv = new FsKV(path.join(__dirname, "tokens.json"));
const app = createApp(kv);

// Serve Vite dist in local preview mode
import { existsSync } from "fs";
if (existsSync(DIST)) {
  app.use("/*", serveStatic({ root: "../dist" }));
}

const PORT = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[rialo-launchpad] Server on :${PORT}`);
});
