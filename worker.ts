/**
 * worker.ts — Cloudflare Worker entry point
 *
 * Hono is CF-Workers-native: its fetch handler runs without any Node.js
 * dependencies at module parse time, eliminating the 1101 crash caused by
 * Express requiring node:http at import time.
 */

import { createApp } from "./server/app.js";

interface Env {
  TOKENS_KV: KVNamespace;
  RIALO_DEVNET_RPC?: string;
  VITE_PROGRAM_ID?: string;
  ANTHROPIC_API_KEY?: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

let app: ReturnType<typeof createApp> | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Inject CF env vars into process.env so route handlers pick them up
    if (env.RIALO_DEVNET_RPC)  process.env.RIALO_DEVNET_RPC  = env.RIALO_DEVNET_RPC;
    if (env.VITE_PROGRAM_ID)   process.env.VITE_PROGRAM_ID   = env.VITE_PROGRAM_ID;
    if (env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;

    // Lazily create the Hono app once per isolate
    if (!app) app = createApp(env.TOKENS_KV);

    return app.fetch(request);
  },
};
