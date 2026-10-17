/**
 * Chain routes — proxies RPC calls the browser cannot make directly (CORS).
 * All values returned as strings (BigInt-safe JSON).
 */
import { Router } from "express";
import type { RialoClient } from "@rialo/ts-cdk";

export function makeChainRouter(client: RialoClient) {
  const router = Router();

  router.get("/chain", async (_req, res) => {
    try {
      const [height, epoch] = await Promise.all([
        client.getBlockHeight(),
        client.getEpochInfo(),
      ]);
      res.json({
        blockHeight: height.toString(),
        epoch: epoch.epoch.toString(),
        slot: epoch.absoluteSlot.toString(),
      });
    } catch (e: unknown) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post("/rpc/config-hash", async (_req, res) => {
    try {
      const configHashPrefix = await client.getConfigHashPrefix();
      const val = configHashPrefix.toString();
      res.json({ configHashPrefix: val, configHash: val });
    } catch (e: unknown) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post("/rpc/send-tx", async (req, res) => {
    try {
      const { txBase64 } = req.body as { txBase64?: string };
      if (!txBase64) return res.status(400).json({ error: "txBase64 required" });
      const txBytes = new Uint8Array(Buffer.from(txBase64, "base64"));
      // sendAndConfirm with timeout fallback is handled by the caller utility
      const { sendAndConfirm } = await import("../utils.js");
      const sig = await sendAndConfirm(client, txBytes);
      res.json({ signature: sig });
    } catch (e: unknown) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.get("/balance/:pubkey", async (req, res) => {
    try {
      const { PublicKey } = await import("@rialo/ts-cdk");
      const pk = PublicKey.fromString(req.params.pubkey);
      const bal = await client.getBalance(pk);
      const KELVIN_PER_RLO = 1_000_000_000;
      res.json({ kelvin: bal.toString(), rlo: (Number(bal) / KELVIN_PER_RLO).toFixed(6) });
    } catch (e: unknown) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return router;
}
