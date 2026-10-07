"""
Configure the Rialo deployer keypair from RIALO_DEPLOY_KEY env var.
If not set, generates a disposable one for the build.
Writes to ~/.config/rialo/id.json and ~/.config/solana/id.json.
"""
import hashlib
import json
import os
import sys


def make_disposable_keypair() -> list[int]:
    """Pure-Python Ed25519 keypair — disposable, used only when no secret is set."""
    p = 2**255 - 19
    d = -121665 * pow(121666, p - 2, p) % p

    def recover_x(y: int, sign: int) -> int:
        x2 = (y * y - 1) * pow(d * y * y + 1, p - 2, p) % p
        x = pow(x2, (p + 3) // 8, p)
        if (x * x - x2) % p != 0:
            x = x * pow(2, (p - 1) // 4, p) % p
        if (x & 1) != sign:
            x = p - x
        return x

    By = 4 * pow(5, p - 2, p) % p
    Bx = recover_x(By, 0)
    B = (Bx, By)

    def add(P: tuple[int, int], Q: tuple[int, int]) -> tuple[int, int]:
        x1, y1 = P
        x2, y2 = Q
        x3 = (x1 * y2 + x2 * y1) * pow(1 + d * x1 * x2 * y1 * y2, p - 2, p) % p
        y3 = (y1 * y2 + x1 * x2) * pow(1 - d * x1 * x2 * y1 * y2, p - 2, p) % p
        return (x3, y3)

    def mul(s: int, P: tuple[int, int]) -> tuple[int, int]:
        Q: tuple[int, int] = (0, 1)
        while s > 0:
            if s & 1:
                Q = add(Q, P)
            P = add(P, P)
            s >>= 1
        return Q

    seed = os.urandom(32)
    h = hashlib.sha512(seed).digest()
    a = bytearray(h[:32])
    a[0] &= 248
    a[31] &= 127
    a[31] |= 64
    A = mul(int.from_bytes(a, "little"), B)
    pub = bytearray(A[1].to_bytes(32, "little"))
    pub[31] |= (A[0] & 1) << 7
    return list(seed + bytes(pub))


def main() -> None:
    key_env = os.environ.get("RIALO_DEPLOY_KEY", "").strip()
    if key_env:
        print("Loading deployer keypair from RIALO_DEPLOY_KEY secret...")
        try:
            raw_key = json.loads(key_env)
        except Exception:
            print("::error::RIALO_DEPLOY_KEY must be a JSON array of 64 integers")
            sys.exit(1)
    else:
        print("::notice::RIALO_DEPLOY_KEY not set — generating disposable keypair")
        raw_key = make_disposable_keypair()

    if not isinstance(raw_key, list) or len(raw_key) != 64:
        print("::error::Keypair must be a list of 64 integers (0..255)")
        sys.exit(1)

    paths = [
        os.path.expanduser("~/.config/rialo/id.json"),
        os.path.expanduser("~/.config/rialo/deployer.keypair"),
        os.path.expanduser("~/.config/solana/id.json"),
    ]
    for path in paths:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(raw_key, f)
        os.chmod(path, 0o600)
    print("Deployer keypair configured.")


if __name__ == "__main__":
    main()
