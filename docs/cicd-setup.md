# CI/CD Setup Guide — hugefun on Rialo Devnet

hugefun uses **Rialo**, a custom blockchain (by Subzero Labs) whose programs are
compiled as **Solana-compatible eBPF shared libraries** (`.so`) and deployed with
the Rialo CDK's `ProgramDeployment`. This is **not EVM** — there are no Solidity
contracts, no Foundry, no `forge` commands.

---

## Program architecture

| File | Purpose |
|---|---|
| `program/Cargo.toml` | Rust crate definition — compiles to eBPF `.so` |
| `program/src/lib.rs` | On-chain bonding-curve program (CreateToken / Buy / Sell) |
| `scripts/deploy-program.ts` | TypeScript deploy script using `@rialo/ts-cdk ProgramDeployment` |

---

## Workflows

| File | Trigger | What it does |
|---|---|---|
| `ci.yml` | Every push / PR | TS lint + typecheck; `cargo check`; `cargo test`; `cargo build-sbf` |
| `deploy-contracts.yml` | Push to `main` (program changed) or manual | Builds `.so`, runs tests, deploys to Rialo devnet via `ProgramDeployment`, updates `AGENTS.md` |
| `deploy-app.yml` | Push to `main` (non-program changes) or manual | Vite build; deploy stubs for Fly.io / Railway / Render |

---

## Required GitHub Secrets

**Settings → Secrets and variables → Actions:**

| Secret | Description | How to get it |
|---|---|---|
| `DEPLOYER_SECRET_HEX` | 64-char hex Ed25519 private key for the deployer wallet | Generate via `/wallet/generate` endpoint or any Ed25519 keygen |
| `PROGRAM_KEYPAIR_HEX` | 64-char hex Ed25519 key that becomes the stable program ID | **Generated on first deploy** — the deploy script prints it; save it immediately |

## GitHub Variables (non-secret)

| Variable | Default | Description |
|---|---|---|
| `RIALO_DEVNET_RPC` | `https://devnet.rialo.io:4101` | Rialo devnet JSON-RPC URL |

---

## Building locally

```bash
# Install Rust + Solana CLI (provides cargo-build-sbf)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Build the eBPF binary
cd program
cargo build-sbf --manifest-path Cargo.toml
# Output: program/target/deploy/hugefun_program.so

# Run native unit tests
cargo test
```

---

## Deploying locally

```bash
# Set env vars
export DEPLOYER_SECRET_HEX=<your 64-char hex key>
export PROGRAM_KEYPAIR_HEX=<your 64-char hex program keypair>  # omit on first deploy
export RIALO_DEVNET_RPC=https://devnet.rialo.io:4101

bun run scripts/deploy-program.ts
```

On **first deploy**, omit `PROGRAM_KEYPAIR_HEX` — the script generates a fresh one and
prints it. Save that value as `PROGRAM_KEYPAIR_HEX` for all future upgrades, otherwise
a new program ID is created each time.

---

## Generating a deployer wallet

```bash
# Via the hugefun API server (must be running)
curl -X POST http://localhost:3001/wallet/generate
# Returns: { secretHex: "...", note: "..." }

# Fund it on devnet
curl -X POST http://localhost:3001/airdrop \
  -H "Content-Type: application/json" \
  -d '{"pubkey": "<your pubkey>", "amount": 100}'
```

---

## Environment variables for the deployed server

| Variable | Required | Description |
|---|---|---|
| `RIALO_DEVNET_RPC` | No | RPC URL (defaults to `https://devnet.rialo.io:4101`) |
| `RIALO_DEPLOYER_SECRET_HEX` | No | Server deployer keypair (enables real TX broadcast) |
| `PORT` | No | HTTP port (defaults to `3001`) |
