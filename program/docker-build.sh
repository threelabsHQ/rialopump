#!/usr/bin/env bash
# Runs inside the ubuntu:22.04 build container.
# Installs rialoman + rialo toolchain, then builds the program.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  build-essential pkg-config libssl-dev curl git \
  clang llvm binaryen ca-certificates cmake ninja-build \
  protobuf-compiler python3 xz-utils 2>&1 | tail -3

# Install Rust stable (needed by rialoman itself)
curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain stable
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add wasm32-unknown-unknown wasm32-wasip1

# Install rialoman
curl -fsSL https://rialo-artifacts.s3.us-east-2.amazonaws.com/rialoman/stable/install.sh \
  | bash -s -- --no-modify-path --default-toolchain none
export PATH="$HOME/.local/share/rialo/bin:$PATH"
rialoman --version

# Install Rialo stable@0.12.2 + toolchain 0.0.3
rialoman install stable@0.12.2 --default
rialoman use stable@0.12.2 || true
rialoman toolchain install rialo-rust --version 0.0.3 || \
  echo "::notice::Prebuilt toolchain 0.0.3 not available — rialo-build will use its own"
rialoman list || true

# Patch zerocopy if needed
cd /program
cargo update -p zerocopy --precise 0.7.35 2>/dev/null || cargo update -p zerocopy || true

# Build
mkdir -p /program/artifacts
rialo-build \
  --program-path /program \
  --output-dir /program/artifacts

echo ""
echo "=== Build artifacts ==="
ls -la /program/artifacts/
sha256sum /program/artifacts/* || true

# Verify
COUNT=$(find /program/artifacts -name "*.polkavm" | wc -l)
if [ "$COUNT" -eq 0 ]; then
  echo "ERROR: no .polkavm produced" && exit 1
fi
echo "SUCCESS: .polkavm artifact ready"
