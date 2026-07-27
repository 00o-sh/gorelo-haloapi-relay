# Gorelo OpenAPI spec

The relay hand-writes its Gorelo request/response types (`src/types.ts`) and
shapes the Halo mock around Gorelo's real API. The authoritative contract for
that API is Gorelo's published OpenAPI (Swagger) document.

## Source of truth

- **Swagger UI:** <https://api.usw.gorelo.io/swagger/index.html>
- **Spec JSON (what the UI loads):** <https://api.usw.gorelo.io/swagger/v1/swagger.json>
- **AU region base:** `https://api.aue.gorelo.io` (same `/swagger/v1/swagger.json` path)

The Swagger UI page is just a `SwaggerUIBundle` shell; view its source and you'll
see it points at `/swagger/v1/swagger.json`. That JSON URL is the one to fetch
directly.

## Committed snapshot

A snapshot of the live spec is committed at
[`gorelo-swagger.v1.json`](gorelo-swagger.v1.json) so the types have a stable,
reviewable reference and changes to the upstream API show up as a diff.

Refresh or verify it with the helper script (standard library only, no deps):

```sh
# Rewrite the snapshot from the live spec (prints a change summary)
scripts/sync-gorelo-swagger.py --summary

# CI-style check: exit non-zero if the snapshot is stale, without writing
scripts/sync-gorelo-swagger.py --check

# Point at another spec URL (e.g. the AU region)
GORELO_SWAGGER_URL=https://api.aue.gorelo.io/swagger/v1/swagger.json \
  scripts/sync-gorelo-swagger.py --check
```

The script serializes the spec deterministically (2-space indent, UTF-8,
trailing newline), so a byte diff in the snapshot reflects a real upstream change
rather than formatting noise.

## Automated drift detection

The [`gorelo-swagger-drift`](../.github/workflows/gorelo-swagger-drift.yml)
GitHub Actions workflow runs the sync script nightly. When the live spec no
longer matches the committed snapshot it opens (or refreshes) a pull request on
the `automation/gorelo-swagger-sync` branch that updates the snapshot and
summarizes what changed — the prompt to re-verify `src/types.ts` and the mock.
It can also be run on demand from the Actions tab (**Run workflow**).
