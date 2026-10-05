# CI/CD Setup Guide

Three GitHub Actions workflows ship with this repository.

---

## Workflows

| File | Trigger | What it does |
|---|---|---|
| `ci.yml` | Every push / PR | Lint, typecheck, `forge build`, `forge test` |
| `deploy-contracts.yml` | Push to `main` (contracts changed) or manual | Deploys `DeployLaunchpad.s.sol` to Rialo devnet; updates `AGENTS.md` |
| `deploy-app.yml` | Push to `main` (non-contract changes) or manual | Builds Vite frontend; deploy stubs for Fly.io / Railway / Render |

---

## Required GitHub Secrets

Go to **Settings → Secrets and variables → Actions** in your GitHub repo and add:

| Secret name | Description | Where to get it |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Hex private key (no `0x` prefix) of the deployer wallet on Rialo devnet | Generate a new keypair — see below |

## GitHub Variables (non-secret)

| Variable name | Default | Description |
|---|---|---|
| `RIALO_DEVNET_RPC` | `https://devnet.rialo.io:4101` | Rialo devnet JSON-RPC URL. Set this variable if the URL changes. |
| `VITE_API_BASE_URL` | _(empty)_ | Optional: base URL the frontend uses to reach the backend API when deployed |

---

## Generating a Deployer Wallet

The deployer needs a Rialo devnet keypair. You can generate one using the server's `/wallet/generate` endpoint:

```bash
curl -X POST http://localhost:3001/wallet/generate
# returns { secretHex: "...", note: "..." }
```

The `secretHex` value is 64 hex characters — paste it as `DEPLOYER_PRIVATE_KEY`.

Then fund it on devnet:

```bash
PUBKEY=$(curl -s http://localhost:3001/deployer | jq -r .pubkey)
curl -X POST http://localhost:3001/airdrop \
  -H "Content-Type: application/json" \
  -d "{\"pubkey\": \"$PUBKEY\", \"amount\": 10}"
```

Or set `RIALO_DEPLOYER_SECRET_HEX` in your server's `.env` and call `/airdrop` from the UI.

---

## Contract Deploy Flow

1. Push to `main` with any change under `contracts/`, `foundry.toml`, or `remappings.txt`.
2. The `deploy-contracts` workflow runs `forge test` first — it aborts if tests fail.
3. `DeployLaunchpad.s.sol` is broadcast via `forge script --broadcast`.
4. The `Create2Factory` address is extracted from stdout (`FACTORY=0x...`).
5. `AGENTS.md` is updated with the new address and auto-committed (`[skip ci]`).

To add more contracts, open `contracts/script/DeployLaunchpad.s.sol` and fill in `_deployLaunchpadContracts()`.

### Manual / dry-run

From the **Actions** tab → **Deploy Contracts** → **Run workflow**:

- `dry_run: true` — simulates without broadcasting
- `reuse_factory: 0x...` — reuses an existing `Create2Factory` (avoids a new deploy fee)

---

## App Deploy Flow

The `deploy-app.yml` workflow builds the Vite frontend to `dist/` and uploads it as a GitHub artifact. Uncomment the relevant `deploy-*` job block for your hosting provider:

- **Fly.io**: add `FLY_API_TOKEN` secret; run `fly launch` once to create `fly.toml`
- **Railway**: add `RAILWAY_TOKEN` secret
- **Render**: add `RENDER_DEPLOY_HOOK_URL` secret (from Render dashboard → Deploy Hook)

The server (`server/index.ts`) is a plain Express app — any Node/Bun-capable host works. The `package.json` `start` script (`bun run server/index.ts`) is used by Docker-based hosts.

---

## Environment Variables for the Deployed Server

Set these in your hosting provider's environment config:

| Variable | Required | Description |
|---|---|---|
| `RIALO_DEVNET_RPC` | No | RPC URL (defaults to `https://devnet.rialo.io:4101`) |
| `RIALO_DEPLOYER_SECRET_HEX` | No | Deployer keypair hex (enables real TX broadcast instead of simulation) |
| `PORT` | No | HTTP port (defaults to `3001`) |
