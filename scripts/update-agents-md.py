"""
Update AGENTS.md with the deployed Rialo program ID.
Usage: python3 scripts/update-agents-md.py <program_id>
"""
import re
import sys
from datetime import datetime, timezone


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: update-agents-md.py <program_id>")
        sys.exit(1)

    program_id = sys.argv[1]
    deployed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    section = (
        "## Deployed Program\n\n"
        f"- **Chain**: Rialo Devnet\n"
        f"- **Program ID**: `{program_id}`\n"
        f"- **Binary**: PolkaVM (.polkavm)\n"
        f"- **Deployed at**: {deployed_at}\n"
        f"- **Explorer**: https://devnet.rialo.io/program/{program_id}"
    )

    try:
        content = open("AGENTS.md").read()
    except FileNotFoundError:
        content = ""

    if "## Deployed Program" in content:
        content = re.sub(
            r"## Deployed Program.*?(?=\n## |\Z)",
            section,
            content,
            flags=re.DOTALL,
        )
    else:
        content = content.rstrip("\n") + "\n\n" + section + "\n"

    with open("AGENTS.md", "w") as f:
        f.write(content)

    print(f"Updated AGENTS.md with program ID: {program_id}")


if __name__ == "__main__":
    main()
