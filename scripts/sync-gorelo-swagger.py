#!/usr/bin/env python3
"""Sync (or check) the committed Gorelo OpenAPI snapshot against the live spec.

The relay hand-writes its Gorelo request/response types (src/types.ts) from this
spec and shapes the Halo mock around it, so a change to the live spec is a signal
to re-verify those. The snapshot lives at docs/gorelo-swagger.v1.json and is
serialized deterministically (2-space indent, UTF-8, trailing newline) so a byte
diff reflects a real spec change and not formatting noise.

Usage:
  scripts/sync-gorelo-swagger.py             # fetch the live spec, rewrite the snapshot
  scripts/sync-gorelo-swagger.py --check     # exit 1 if the snapshot is stale (no write)
  scripts/sync-gorelo-swagger.py --summary   # print a markdown change summary, then rewrite

Env:
  GORELO_SWAGGER_URL   override the spec URL (default: the US public spec)

Source of truth: https://api.usw.gorelo.io/swagger/v1/swagger.json
(the Swagger UI at https://api.usw.gorelo.io/swagger/index.html loads this file).

Requires only the Python 3 standard library (urllib) — no pip install.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

DEFAULT_URL = "https://api.usw.gorelo.io/swagger/v1/swagger.json"
SNAPSHOT = Path(__file__).resolve().parent.parent / "docs" / "gorelo-swagger.v1.json"


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (trusted host)
        return json.loads(resp.read().decode("utf-8"))


def serialize(spec: dict) -> str:
    """The single canonical serialization — used for both writing and comparing."""
    return json.dumps(spec, indent=2, ensure_ascii=False) + "\n"


def load_snapshot() -> dict | None:
    if not SNAPSHOT.exists():
        return None
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))


def summarize(old: dict | None, new: dict) -> list[str]:
    """A concise, human-readable list of what changed between two specs."""
    lines: list[str] = []
    if old is None:
        return ["- Snapshot did not exist yet; created from the live spec."]

    ov = old.get("info", {}).get("version")
    nv = new.get("info", {}).get("version")
    if ov != nv:
        lines.append(f"- `info.version`: `{ov}` → `{nv}`")

    old_paths, new_paths = old.get("paths", {}), new.get("paths", {})
    for p in sorted(set(new_paths) - set(old_paths)):
        methods = ", ".join(sorted(new_paths[p]))
        lines.append(f"- **Path added**: `{p}` ({methods})")
    for p in sorted(set(old_paths) - set(new_paths)):
        lines.append(f"- **Path removed**: `{p}`")
    for p in sorted(set(old_paths) & set(new_paths)):
        om, nm = set(old_paths[p]), set(new_paths[p])
        for m in sorted(nm - om):
            lines.append(f"- **Method added**: `{m.upper()} {p}`")
        for m in sorted(om - nm):
            lines.append(f"- **Method removed**: `{m.upper()} {p}`")

    old_sch = old.get("components", {}).get("schemas", {})
    new_sch = new.get("components", {}).get("schemas", {})
    for s in sorted(set(new_sch) - set(old_sch)):
        lines.append(f"- **Schema added**: `{s}`")
    for s in sorted(set(old_sch) - set(new_sch)):
        lines.append(f"- **Schema removed**: `{s}`")
    for s in sorted(set(old_sch) & set(new_sch)):
        op = set(old_sch[s].get("properties", {}))
        np = set(new_sch[s].get("properties", {}))
        if op != np:
            added = ", ".join(f"`{x}`" for x in sorted(np - op)) or "—"
            removed = ", ".join(f"`{x}`" for x in sorted(op - np)) or "—"
            lines.append(f"- **Schema changed**: `{s}` (added: {added}; removed: {removed})")

    if not lines:
        lines.append("- Fields changed below the path/schema-property level (see the file diff).")
    return lines


def main() -> int:
    args = set(sys.argv[1:])
    check_only = "--check" in args
    want_summary = "--summary" in args
    url = os.environ.get("GORELO_SWAGGER_URL", DEFAULT_URL)

    try:
        live = fetch(url)
    except Exception as err:  # noqa: BLE001 — surface any fetch/parse failure clearly
        print(f"failed to fetch {url}: {err}", file=sys.stderr)
        return 2

    rendered = serialize(live)
    current = SNAPSHOT.read_text(encoding="utf-8") if SNAPSHOT.exists() else None
    changed = rendered != current

    if changed and (want_summary or check_only):
        print(f"Gorelo OpenAPI spec drift detected against `{url}`:\n")
        for line in summarize(load_snapshot(), live):
            print(line)
        print()
    elif want_summary:
        print(f"No drift: the snapshot already matches `{url}`.")

    if check_only:
        if changed:
            print("snapshot is STALE — run scripts/sync-gorelo-swagger.py to update it", file=sys.stderr)
            return 1
        print("snapshot is up to date", file=sys.stderr)
        return 0

    if changed:
        SNAPSHOT.write_text(rendered, encoding="utf-8")
        print(f"updated {SNAPSHOT.relative_to(SNAPSHOT.parent.parent)}", file=sys.stderr)
    else:
        print("snapshot already up to date", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
