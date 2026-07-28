# Halo OpenAPI spec

The relay presents a HaloPSA-compatible mock (`src/halo.ts`, `src/haloShapes.ts`)
so a strict Halo client (Huntress, Tier2) can authenticate, look up entities, and
create tickets against it. The authoritative contract for those shapes is
HaloPSA's published OpenAPI (Swagger) document.

## Source of truth

- **Spec JSON:** <https://potatopsa.halopsa.com/api/swagger/v2/swagger.json>

HaloPSA serves the same v2 API shape across tenants; the tenant host above is just
the instance the snapshot is fetched from. Override it per environment with the
`HALO_SWAGGER_URL` env var if you sync from a different Halo host.

## Committed snapshot

A snapshot of the live spec is committed at
[`halo-swagger.v2.json`](halo-swagger.v2.json) so the mock shapes have a stable,
reviewable reference and changes to the upstream API show up as a diff.

Refresh or verify it with the shared helper script (standard library only, no deps):

```sh
# Rewrite the snapshot from the live spec (prints a change summary)
scripts/sync-swagger.py halo --summary

# CI-style check: exit non-zero if the snapshot is stale, without writing
scripts/sync-swagger.py halo --check

# Point at a different Halo host
HALO_SWAGGER_URL=https://yourtenant.halopsa.com/api/swagger/v2/swagger.json \
  scripts/sync-swagger.py halo --check
```

The script serializes the spec deterministically (2-space indent, UTF-8,
trailing newline), so a byte diff in the snapshot reflects a real upstream change
rather than formatting noise.

## Automated drift detection

The [`swagger-drift`](../.github/workflows/swagger-drift.yml) GitHub Actions
workflow runs the sync script nightly for each spec (a `gorelo` + `halo` matrix).
When the live Halo spec no longer matches the committed snapshot it opens (or
refreshes) a pull request on the `automation/halo-swagger-sync` branch that
updates the snapshot and summarizes what changed — the prompt to re-verify the
Halo mock responses. It can also be run on demand from the Actions tab
(**Run workflow**).
