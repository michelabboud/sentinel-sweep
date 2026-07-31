#!/usr/bin/env python3
"""Transparent Codex launcher for Sentinel's dependency-free Node.js CLI."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


NODE_VERSION = re.compile(r"^v?([0-9]+)\.")


def fail(message: str) -> int:
    print(f"sentinel: {message}", file=sys.stderr)
    return 1


def resolve_cli():
    try:
        plugin_root = Path(__file__).resolve(strict=True).parents[2]
        cli = (plugin_root / "runtime" / "cli.mjs").resolve(strict=True)
        cli.relative_to(plugin_root)
    except (IndexError, OSError, ValueError):
        return None
    return cli if cli.is_file() else None


def resolve_node():
    discovered = shutil.which("node")
    if discovered is None:
        return None
    try:
        return str(Path(discovered).resolve(strict=True))
    except OSError:
        return None


def node_is_supported(node: str) -> bool:
    try:
        result = subprocess.run(
            [node, "--version"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    match = NODE_VERSION.match(result.stdout.strip())
    return result.returncode == 0 and match is not None and int(match.group(1)) >= 18


def main() -> int:
    cli = resolve_cli()
    if cli is None:
        return fail("runtime CLI is unavailable")

    node = resolve_node()
    if node is None:
        return fail("Node.js 18 or newer is required")
    if not node_is_supported(node):
        return fail("Node.js 18 or newer is required")

    try:
        os.execv(node, [node, str(cli), *sys.argv[1:]])
    except OSError:
        return fail("could not execute Node.js")


if __name__ == "__main__":
    raise SystemExit(main())
