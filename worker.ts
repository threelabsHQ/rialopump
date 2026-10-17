/**
 * worker.ts — Cloudflare Worker entry point
 *
 * Wraps the Express app in a standard fetch handler via @whatwg-node/server.
 * Token state is persisted in Cloudflare KV (binding: TOKENS_KV).
 * Static assets are served by Workers Assets (configured in wrangler.toml).
 */

import { createServerAdapter } from "@whatwg-node/server";
import { createApp } from "./server/app.js";

// CF Workers KV binding type
interface Env {
  TOKENS_KV: KVNamespace;
  RIALO_DEVNET_RPC?: string;
  VITE_PROGRAM_ID?: string;
  ANTHROPIC_API_KEY?: string;
}

// CF Workers KV namespace interface
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

let fetchHandler: ReturnType<typeof createServerAdapter> | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Inject CF env vars into process.env so Express handlers pick them up
    if (env.RIALO_DEVNET_RPC)  process.env.RIALO_DEVNET_RPC  = env.RIALO_DEVNET_RPC;
    if (env.VITE_PROGRAM_ID)   process.env.VITE_PROGRAM_ID   = env.VITE_PROGRAM_ID;
    if (env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;

    // Create the adapter once per isolate (Workers Assets handles static files
    // before this fetch handler runs, so we only see /api/* and SPA routes here)
    if (!fetchHandler) {
      fetchHandler = createServerAdapter(createApp(env.TOKENS_KV));
    }

    return fetchHandler.fetch(request) as Promise<Response>;
  },
};
