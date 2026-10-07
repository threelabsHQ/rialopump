/**
 * deploy-program.ts
 *
 * Deploys the hugefun PolkaVM program binary to Rialo devnet using
 * the `rialo program deploy` CLI (same tool the rexo reference uses).
 *
 * Required env vars (set as GitHub Actions secrets):
 *   RIALO_DEPLOY_KEY   — JSON array of 64 integers (Ed25519 keypair)
 *                        Generate: node -e "const c=require('crypto');const s=c.randomBytes(32);console.log(JSON.stringify([...s,...c.randomBytes(32)]))"
 *                        (or use the same Python keypair generator in the workflow)
 *
 * Optional:
 *   RIALO_NETWORK      — "devnet" | "testnet" (default: devnet)
 *   POLKAVM_PATH       — path to .polkavm binary (default: program/artifacts/*.polkavm)
 *
 * This script is a thin orchestrator; the actual deploy is handled by
 * the `rialo program deploy` CLI that rialoman installs.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import os from "os";

const NETWORK = process.env.RIALO_NETWORK ?? "devnet";

// ── Locate .polkavm binary ──────────────────────────────────────────────────

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

const defaultArtifacts = "program/artifacts";
let polkavmPath = process.env.POLKAVM_PATH;

if (!polkavmPath) {
  const found = findPolkavm(defaultArtifacts);
  if (!found) {
    console.error(
      `ERROR: No .polkavm binary found under ${defaultArtifacts}\n` +
        "Build first: run the CI workflow or rialo-build --program-path program --output-dir program/artifacts"
    );
    process.exit(1);
  }
  polkavmPath = found;
}

if (!fs.existsSync(polkavmPath)) {
  console.error(`ERROR: .polkavm not found at ${polkavmPath}`);
  process.exit(1);
}

// ── Set up deployer keypair ─────────────────────────────────────────────────

const deployKeyEnv = process.env.RIALO_DEPLOY_KEY;

const keypairDir = path.join(os.homedir(), ".config", "rialo");
const keypairPath = path.join(keypairDir, "id.json");

if (deployKeyEnv) {
  // Validate and write the JSON 64-int array keypair
  let raw: unknown;
  try {
    raw = JSON.parse(deployKeyEnv);
  } catch {
    console.error("ERROR: RIALO_DEPLOY_KEY must be a valid JSON array of 64 integers");
    process.exit(1);
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((x) => typeof x === "number" && x >= 0 && x <= 255)) {
    console.error("ERROR: RIALO_DEPLOY_KEY must be a JSON array of exactly 64 integers (0..255)");
    process.exit(1);
  }
  fs.mkdirSync(keypairDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keypairPath, JSON.stringify(raw), { mode: 0o600 });
  console.log(`Deployer keypair written to ${keypairPath}`);
} else if (!fs.existsSync(keypairPath)) {
  console.error(
    "ERROR: No deployer keypair found.\n" +
      "Set RIALO_DEPLOY_KEY to a JSON array of 64 integers, or place id.json at ~/.config/rialo/id.json\n" +
      "Generate a keypair:\n" +
      '  node -e "const c=require(\'crypto\');const s=c.randomBytes(32);console.log(JSON.stringify([...s,...c.randomBytes(32)]))"'
  );
  process.exit(1);
} else {
  console.log(`Using existing keypair at ${keypairPath}`);
}

// ── Run deploy ──────────────────────────────────────────────────────────────

console.log("=== hugefun program deploy ===");
console.log("Network:", NETWORK);
console.log("Binary:", polkavmPath, `(${(fs.statSync(polkavmPath).size / 1024).toFixed(1)} KB)`);

const deployCommands = [
  ["rialo", "program", "deploy", polkavmPath, "--keypair", keypairPath, "--url", NETWORK],
  ["rialo", "program", "deploy", polkavmPath, "-k", keypairPath, "-u", NETWORK],
  ["rialo", "client", "program", "deploy", "-n", NETWORK, polkavmPath],
];

let deployed = false;
let outputLog = "";

for (const args of deployCommands) {
  console.log(`\n--> Trying: ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf-8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  outputLog = (result.stdout ?? "") + (result.stderr ?? "");
  process.stdout.write(outputLog);

  if (result.status === 0 && !outputLog.toLowerCase().includes("error:")) {
    deployed = true;
    break;
  }
}

if (!deployed) {
  console.error("\nERROR: All deploy attempts failed.");
  process.exit(1);
}

// ── Extract program ID from output ──────────────────────────────────────────

const programIdMatch = outputLog.match(/[A-Za-z0-9]{32,}/g);
const programId = programIdMatch ? programIdMatch[programIdMatch.length - 1] : null;

if (programId) {
  console.log(`\n✓ Program deployed: ${programId}`);
  console.log(`  Explorer: https://devnet.rialo.io/program/${programId}`);

  // ── Update AGENTS.md ──────────────────────────────────────────────────────
  const agentsPath = "AGENTS.md";
  let agentsContent = fs.existsSync(agentsPath)
    ? fs.readFileSync(agentsPath, "utf-8")
    : "";

  const section = [
    "## Deployed Program",
    "",
    `- **Chain**: Rialo ${NETWORK.charAt(0).toUpperCase() + NETWORK.slice(1)}`,
    `- **Program ID**: \`${programId}\``,
    "- **Binary**: PolkaVM (.polkavm)",
    `- **Deployed at**: ${new Date().toISOString()}`,
    `- **Explorer**: https://devnet.rialo.io/program/${programId}`,
    "",
  ].join("\n");

  if (agentsContent.includes("## Deployed Program")) {
    agentsContent = agentsContent.replace(
      /## Deployed Program[\s\S]*?(?=\n## |\s*$)/,
      section
    );
  } else {
    agentsContent += "\n" + section;
  }

  fs.writeFileSync(agentsPath, agentsContent);
  console.log("✓ AGENTS.md updated");
} else {
  console.log("✓ Deploy appears successful (could not extract program ID from output)");
}

console.log("\n=== Deploy complete ===");
