/**
 * deploy-program.ts
 *
 * Deploys the hugefun PolkaVM program binary to Rialo devnet using
 * ProgramDeployment from @rialo/ts-cdk.
 *
 * Required env vars:
 *   DEPLOYER_SECRET_HEX   — 64-char hex Ed25519 seed (the deployer/payer wallet)
 *   PROGRAM_KEYPAIR_HEX   — 64-char hex Ed25519 seed for the program account
 *                           (generate once: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
 *                           Save this! Same key = same program ID = upgradeable.
 *   POLKAVM_PATH          — path to the compiled .polkavm binary
 *                           (defaults to program/target/hugefun-program-riscv/hugefun_program.polkavm)
 *
 * Optional:
 *   RIALO_DEVNET_RPC      — RPC URL (default: https://devnet.rialo.io:4101)
 */

import fs from "fs";
import path from "path";
import {
  createRialoClient,
  RIALO_DEVNET_CHAIN,
  Keypair,
  ProgramDeployment,
} from "@rialo/ts-cdk";

// ── Config ─────────────────────────────────────────────────────────────────

const RPC_URL =
  process.env.RIALO_DEVNET_RPC ?? "https://devnet.rialo.io:4101";

const DEPLOYER_HEX = process.env.DEPLOYER_SECRET_HEX;
if (!DEPLOYER_HEX || DEPLOYER_HEX.length !== 64) {
  console.error(
    "ERROR: DEPLOYER_SECRET_HEX must be set to a 64-char hex string (32-byte Ed25519 seed)"
  );
  process.exit(1);
}

const PROGRAM_KEYPAIR_HEX = process.env.PROGRAM_KEYPAIR_HEX;
if (!PROGRAM_KEYPAIR_HEX || PROGRAM_KEYPAIR_HEX.length !== 64) {
  console.error(
    "ERROR: PROGRAM_KEYPAIR_HEX must be set to a 64-char hex string.\n" +
      "Generate one (do this once and save it):\n" +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
  process.exit(1);
}

// Locate .polkavm binary
const DEFAULT_POLKAVM = path.resolve(
  "program/target/hugefun-program-riscv/hugefun_program.polkavm"
);
const polkavmPath = process.env.POLKAVM_PATH ?? DEFAULT_POLKAVM;

if (!fs.existsSync(polkavmPath)) {
  // Try any .polkavm under program/target
  const found = findPolkavm("program/target");
  if (!found) {
    console.error(
      `ERROR: .polkavm binary not found at ${polkavmPath}\n` +
        "Build first: cd program && cargo +rialo build --release"
    );
    process.exit(1);
  }
  console.log(`Using .polkavm found at: ${found}`);
  process.env.POLKAVM_PATH = found;
}

function findPolkavm(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findPolkavm(full);
      if (found) return found;
    } else if (entry.name.endsWith(".polkavm")) {
      return full;
    }
  }
  return null;
}

const resolvedPolkavmPath =
  process.env.POLKAVM_PATH ?? DEFAULT_POLKAVM;

// ── Keypairs ───────────────────────────────────────────────────────────────

function keypairFromHex(hex: string): Keypair {
  const bytes = Buffer.from(hex, "hex");
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

const deployerKeypair = keypairFromHex(DEPLOYER_HEX);
const programKeypair = keypairFromHex(PROGRAM_KEYPAIR_HEX);

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== hugefun program deploy ===");
  console.log("RPC:", RPC_URL);
  console.log("Deployer:", deployerKeypair.publicKey.toString());
  console.log("Program ID:", programKeypair.publicKey.toString());
  console.log("Binary:", resolvedPolkavmPath);

  const programData = new Uint8Array(fs.readFileSync(resolvedPolkavmPath));
  console.log(`Binary size: ${(programData.length / 1024).toFixed(1)} KB`);

  const client = createRialoClient({
    chain: {
      ...RIALO_DEVNET_CHAIN,
      rpcUrl: RPC_URL,
    },
  });

  // Check deployer balance
  const balance = await client.getBalance(deployerKeypair.publicKey);
  const balanceRlo = Number(balance) / 1_000_000_000;
  console.log(`Deployer balance: ${balanceRlo.toFixed(4)} RLO`);
  if (Number(balance) < 1_000_000_000) {
    console.error(
      "ERROR: Deployer needs at least 1 RLO. Use the /airdrop endpoint to fund it."
    );
    process.exit(1);
  }

  console.log("\nDeploying (this uploads in chunks — may take 1–2 min)…");

  const deployment = new ProgramDeployment({
    programData,
    programKeypair,
    config: {
      chunkSize: 900,
      maxRetries: 5,
    },
  });

  const programId = await deployment.deploy(client, deployerKeypair);
  const programIdStr = programId.toString();

  console.log(`\n✓ Program deployed: ${programIdStr}`);
  console.log(`  Explorer: https://devnet.rialo.io/program/${programIdStr}`);

  // ── Update AGENTS.md ──────────────────────────────────────────────────────
  const agentsPath = "AGENTS.md";
  let agentsContent = fs.existsSync(agentsPath)
    ? fs.readFileSync(agentsPath, "utf-8")
    : "";

  const programSection = `\n## Deployed Program\n\n- **Chain**: Rialo Devnet\n- **Program ID**: \`${programIdStr}\`\n- **Binary**: PolkaVM (.polkavm)\n- **Deployed at**: ${new Date().toISOString()}\n- **Explorer**: https://devnet.rialo.io/program/${programIdStr}\n`;

  if (agentsContent.includes("## Deployed Program")) {
    agentsContent = agentsContent.replace(
      /## Deployed Program[\s\S]*?(?=\n## |$)/,
      programSection.trim() + "\n"
    );
  } else {
    agentsContent += programSection;
  }

  fs.writeFileSync(agentsPath, agentsContent);
  console.log("✓ AGENTS.md updated with program ID");

  console.log("\n=== Deploy complete ===");
}

main().catch((err) => {
  console.error("Deploy failed:", err);
  process.exit(1);
});
