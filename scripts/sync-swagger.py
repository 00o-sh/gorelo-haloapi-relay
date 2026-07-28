#!/usr/bin/env python3
"""Sync (or check) a committed OpenAPI snapshot against its live spec.

Two upstream specs shape this relay, and a change to either is a signal to
re-verify the code derived from it:
  - gorelo: the relay hand-writes its Gorelo request/response types (src/types.ts)
            from this spec.
  - halo:   the relay shapes its Halo mock (src/halo.ts, src/haloShapes.ts) around
            this spec so a strict Halo client can't hit an undefined field.

Each snapshot is serialized deterministically (2-space indent, UTF-8, trailing
newline) so a byte diff reflects a real spec change and not formatting noise.

Usage:
  scripts/sync-swagger.py <spec>             # fetch the live spec, rewrite the snapshot
  scripts/sync-swagger.py <spec> --check     # exit 1 if the snapshot is stale (no write)
  scripts/sync-swagger.py <spec> --summary   # print a markdown change summary, then rewrite

  <spec> is one of: gorelo, halo

Env:
  GORELO_SWAGGER_URL / HALO_SWAGGER_URL   override that spec's URL (e.g. a region mirror)

Sources of truth:
  gorelo: https://api.usw.gorelo.io/swagger/v1/swagger.json
  halo:   https://potatopsa.halopsa.com/api/swagger/v2/swagger.json

Requires only the Python 3 standard library (urllib) — no pip install.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Spec:
    """One upstream OpenAPI spec: where to fetch it, where to snapshot it, why it matters."""

    key: str
    url: str
    snapshot: Path
    title: str
    url_env: str
    derived_note: str


SPECS: dict[str, Spec] = {
    "gorelo": Spec(
        key="gorelo",
        url="https://api.usw.gorelo.io/swagger/v1/swagger.json",
        snapshot=ROOT / "docs" / "gorelo-swagger.v1.json",
        title="Gorelo",
        url_env="GORELO_SWAGGER_URL",
        derived_note=(
            "The relay hand-writes its Gorelo types (`src/types.ts`) from this spec, so please "
            "re-check those types and the mock responses against the diff before merging."
        ),
    ),
    "halo": Spec(
        key="halo",
        url="https://potatopsa.halopsa.com/api/swagger/v2/swagger.json",
        snapshot=ROOT / "docs" / "halo-swagger.v2.json",
        title="Halo",
        url_env="HALO_SWAGGER_URL",
        derived_note=(
            "The relay shapes its Halo mock (`src/halo.ts`, `src/haloShapes.ts`) around this spec, "
            "so please re-check the mock response shapes against the diff before merging."
        ),
    ),
}


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (trusted host)
        return json.loads(resp.read().decode("utf-8"))


def serialize(spec: dict) -> str:
    """The single canonical serialization — used for both writing and comparing."""
    return json.dumps(spec, indent=2, ensure_ascii=False) + "\n"


def load_snapshot(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


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


def usage(err: str | None = None) -> int:
    if err:
        print(err, file=sys.stderr)
    print(f"usage: {sys.argv[0]} <{'|'.join(SPECS)}> [--check | --summary]", file=sys.stderr)
    return 2


def main() -> int:
    args = sys.argv[1:]
    flags = {a for a in args if a.startswith("-")}
    positional = [a for a in args if not a.startswith("-")]
    unknown = flags - {"--check", "--summary"}
    if unknown:
        return usage(f"unknown flag(s): {', '.join(sorted(unknown))}")
    if len(positional) != 1:
        return usage("exactly one spec name is required")
    if positional[0] not in SPECS:
        return usage(f"unknown spec: {positional[0]}")

    spec = SPECS[positional[0]]
    check_only = "--check" in flags
    want_summary = "--summary" in flags
    url = os.environ.get(spec.url_env, spec.url)
    rel = spec.snapshot.relative_to(ROOT)

    try:
        live = fetch(url)
    except Exception as err:  # noqa: BLE001 — surface any fetch/parse failure clearly
        print(f"failed to fetch {url}: {err}", file=sys.stderr)
        return 2

    rendered = serialize(live)
    current = spec.snapshot.read_text(encoding="utf-8") if spec.snapshot.exists() else None
    changed = rendered != current

    if changed and (want_summary or check_only):
        print(f"{spec.title} OpenAPI spec drift detected against `{url}`:\n")
        for line in summarize(load_snapshot(spec.snapshot), live):
            print(line)
        print()
    elif want_summary:
        print(f"No drift: the {spec.title} snapshot already matches `{url}`.")

    if check_only:
        if changed:
            print(f"{rel} is STALE — run scripts/sync-swagger.py {spec.key} to update it", file=sys.stderr)
            return 1
        print(f"{rel} is up to date", file=sys.stderr)
        return 0

    if changed:
        spec.snapshot.write_text(rendered, encoding="utf-8")
        print(f"updated {rel}", file=sys.stderr)
    else:
        print(f"{rel} already up to date", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
