# CI/CD Setup Guide

## Overview

Three GitHub Actions workflows:

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Every push/PR | TS lint + typecheck, Rust check + test, PolkaVM build |
| `deploy-contracts.yml` | Push to main touching `program/**` | Build + deploy .polkavm to Rialo devnet |
| `deploy-app.yml` | Push to main (non-contract paths) | Frontend Vite build |

## Pinned Versions

| Component | Version |
|---|---|
| rialoman | 0.3.0 |
| Rialo Release | stable@0.12.2 |
| Rialo Rust Toolchain | 0.0.3 |
| Build tool | rialo-build |
| Deploy tool | rialo program deploy |

## Required GitHub Secret

### `RIALO_DEPLOY_KEY` (Settings → Secrets → Actions)

A JSON array of **64 integers** (Ed25519 keypair in Solana/Rialo format).

Generate one with:
```bash
node -e "
const c = require('crypto');
const seed = c.randomBytes(32);
// The second 32 bytes are a placeholder public key — rialo CLI computes the real one
const kp = [...seed, ...c.randomBytes(32)];
console.log(JSON.stringify(kp));
"
```

Or with Python (same as the workflow uses):
```python
import os, json, hashlib
# ... (see the Configure Signing Keypair step in deploy-contracts.yml)
```

**Save this value permanently.** The same secret key produces the same program ID — if you lose it you can't upgrade the deployed program.

## Optional GitHub Variable

### `RIALO_NETWORK` (Settings → Variables → Actions)

- `devnet` (default) — public Rialo devnet, has faucet airdrop
- `testnet` — Rialo testnet (requires pre-funded wallet)

## How the Deploy Works

1. `rialo-build --program-path program --output-dir program/artifacts` compiles the Rust source to a `.polkavm` binary
2. The deployer keypair is written to `~/.config/rialo/id.json`
3. `rialo airdrop 2` funds the deployer wallet (devnet only)
4. `rialo program deploy <bin> --keypair <key> --url <network>` uploads the binary in chunks
5. The program ID is extracted from the output and written to `AGENTS.md`
6. `AGENTS.md` is committed back to the repo via `EndBug/add-and-commit@v9`

## Triggering a Manual Deploy

Go to **Actions → Build & Deploy Rialo Program → Run workflow**:
- `network`: devnet or testnet
- `deploy_contract`: true (default) to deploy after build

## Local Development

The Rust program can be checked locally with standard Rust (no rialo toolchain needed):
```bash
cd program
cargo check --features no-entrypoint
cargo test --features no-entrypoint --lib
```

Full `.polkavm` build requires `rialoman` + the rialo toolchain (Ubuntu only, no macOS/Windows support yet):
```bash
# Install rialoman
curl -fsSL https://rialo-artifacts.s3.us-east-2.amazonaws.com/rialoman/stable/install.sh | bash
rialoman install stable@0.12.2 --default

# Build
rialo-build --program-path program --output-dir program/artifacts
```
