/**
 * server/index.ts — Local development entry point
 *
 * Imports the Express app from server/app.ts and starts listening.
 * In production the Worker entry (worker.ts) is used instead.
 */
import path from "path";
import fs from "fs";
import { createApp } from "./app.js";

const app = createApp(); // uses fs-based KV (tokens.json) in local dev

// Serve Vite-built frontend in production / local preview
const DIST = path.join(path.dirname(new URL(import.meta.url).pathname), "../dist");
if (fs.existsSync(DIST)) {
  const { default: express } = await import("express");
  app.use(express.static(DIST));
  app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[rialo-launchpad] Server on :${PORT} | program: ${process.env.VITE_PROGRAM_ID || "2PDinBj36DXxwXd9VR8vKes1c5MfP8QLEaVXDDAnNQ1s"}`);
});
