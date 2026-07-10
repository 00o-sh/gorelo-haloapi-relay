import { initSchema, setLastSync } from "./db.js";
import { GoreloClient } from "./gorelo.js";
import { normalizeHost } from "./parse.js";
import type { Env, PublicContactResponse, PublicDeviceResponse } from "./types.js";

const INSERT_CHUNK = 100; // stay within D1's per-batch statement limits
// Per-client Gorelo calls in flight at once. Kept low: at 5, the fleet's
// per-client location/contact fetches tripped Gorelo's rate limit hard enough
// that some fetches failed every sync (partial runs that never reconcile). The
// client also honors Retry-After now, so a gentle-but-reliable sweep beats a
// fast one that gets throttled.
const FETCH_CONCURRENCY = 2;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Run `fn` over items with bounded concurrency (keeps us under Gorelo rate limits). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Halo asset ids are integers, but Gorelo agent ids are UUIDs. Derive a stable
 * numeric surrogate from the UUID (first 12 hex -> a <=2^48 integer, safely inside
 * Number.MAX_SAFE_INTEGER). Deterministic across syncs; mapped back via D1.
 */
export function assetNum(uuid: string): number {
  const hex = uuid.replace(/[^0-9a-fA-F]/g, "").slice(0, 12);
  const n = Number.parseInt(hex || "0", 16);
  return Number.isFinite(n) ? n : 0;
}

interface DeviceInsert {
  hostname: string;
  clientId: number;
  locationId: number | null;
  agentId: string;
  assetNum: number;
  displayName: string;
  serial: string;
  localIp: string;
  publicIp: string;
  os: string;
}
interface LocationInsert {
  id: number;
  name: string;
  clientId: number;
}
interface ContactInsert {
  id: number;
  email: string;
  name: string;
  clientId: number;
  locationId: number | null;
}

function toDeviceRows(agents: PublicDeviceResponse[]): DeviceInsert[] {
  const rows: DeviceInsert[] = [];
  for (const a of agents) {
    if (a.clientId == null) continue; // can't route without a client
    rows.push({
      hostname: normalizeHost(a.displayName ?? a.name ?? ""),
      clientId: a.clientId,
      locationId: a.clientLocationId ?? null,
      agentId: a.id,
      assetNum: assetNum(a.id),
      displayName: (a.displayName ?? a.name ?? "").trim(),
      serial: (a.serialNo ?? "").trim(),
      localIp: (a.localIPAddress ?? "").trim(),
      publicIp: (a.publicIPAddress ?? "").trim(),
      os: "",
    });
  }
  return rows;
}

function contactName(c: PublicContactResponse): string {
  return [c.firstName ?? "", c.lastName ?? ""].join(" ").trim();
}

/** Per-table reconcile result: mirror size, rows actually written, rows deleted. */
export interface TableStats {
  total: number; // the mirror's actual row count after the sync
  changed: number; // rows actually inserted or updated in D1 this run
  deleted: number; // rows removed because they vanished upstream
}

export interface SyncStats {
  clients: number;
  locations: number;
  contacts: number;
  devices: number;
  /** Rows actually written this run (inserts + updates); 0 on a no-change sync. */
  changed: number;
  /** Rows deleted this run because they disappeared from Gorelo. */
  deleted: number;
  /**
   * True when every Gorelo fetch succeeded. When false, a per-client
   * locations/contacts fetch failed, so those tables were upsert-only (deletes
   * skipped) to avoid dropping rows we merely failed to fetch — totals may
   * include not-yet-reconciled rows until a fully-successful sync.
   */
  complete: boolean;
}

/**
 * Reconcile the D1 mirror against Gorelo: clients, sites, contacts, devices.
 * Delta-only — unchanged rows are left untouched — so writes track churn, not
 * fleet size. Runs off the request path (cron / admin / first-press bootstrap).
 */
export async function syncAll(env: Env): Promise<SyncStats> {
  await initSchema(env.DB);
  const client = new GoreloClient(env);

  const [agents, clients] = await Promise.all([client.listAgents(), client.listClients()]);
  const clientIds = clients.map((c) => c.id);

  // Per-client locations + contacts (bounded concurrency). A per-client fetch can
  // fail (e.g. Gorelo rate-limits under load); if any does, the fetched set is
  // INCOMPLETE and must NOT be treated as authoritative — otherwise the reconcile
  // step would delete every row whose client we simply failed to fetch, then
  // re-insert it next run (write thrash + a window of missing lookups). Track
  // completeness and gate deletes on it below.
  const locationRows: LocationInsert[] = [];
  const contactRows: ContactInsert[] = [];
  let locationsComplete = true;
  let contactsComplete = true;
  await mapLimit(clientIds, FETCH_CONCURRENCY, async (cid) => {
    const [locations, contacts] = await Promise.all([
      client.listLocations(cid).catch((err) => {
        locationsComplete = false;
        console.error(`sync: listLocations(${cid}) failed — skipping location deletes: ${String(err)}`);
        return null;
      }),
      client.listContacts(cid).catch((err) => {
        contactsComplete = false;
        console.error(`sync: listContacts(${cid}) failed — skipping contact deletes: ${String(err)}`);
        return null;
      }),
    ]);
    if (locations) {
      for (const l of locations) {
        locationRows.push({ id: l.id, name: (l.name ?? "").trim(), clientId: cid });
      }
    }
    if (contacts) {
      for (const ct of contacts) {
        const email = (ct.primaryEmail ?? "").trim().toLowerCase();
        if (!email) continue;
        contactRows.push({
          id: ct.id,
          email,
          name: contactName(ct),
          clientId: ct.clientId ?? cid,
          locationId: ct.clientLocationId ?? null,
        });
      }
    }
  });

  const deviceRows = toDeviceRows(agents);
  const clientRows = clients.map((c) => ({ id: c.id, name: (c.name ?? "").trim() }));

  // Delta-reconcile every table: upsert changed/new rows, delete rows that
  // vanished upstream. Unchanged rows write nothing (the ON CONFLICT guards on a
  // real diff), so a no-op sync costs ~0 D1 writes regardless of dataset size.
  const clientStats = await syncTable(env.DB, "clients", "id", clientRows, (r) => r.id, (r) =>
    env.DB
      .prepare(
        `INSERT INTO clients (id, name) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name
         WHERE clients.name IS NOT excluded.name`,
      )
      .bind(r.id, r.name),
  );
  // locations/contacts pass their completeness flag: when a per-client fetch
  // failed, the row set is partial, so upsert-only (no deletes) this run.
  const locationStats = await syncTable(env.DB, "locations", "id", locationRows, (r) => r.id, (r) =>
    env.DB
      .prepare(
        `INSERT INTO locations (id, name, client_id) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, client_id = excluded.client_id
         WHERE locations.name IS NOT excluded.name OR locations.client_id IS NOT excluded.client_id`,
      )
      .bind(r.id, r.name, r.clientId),
    locationsComplete,
  );
  const contactStats = await syncTable(env.DB, "contacts", "id", contactRows, (r) => r.id, (r) =>
    env.DB
      .prepare(
        `INSERT INTO contacts (id, email, name, client_id, location_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email, name = excluded.name,
           client_id = excluded.client_id, location_id = excluded.location_id
         WHERE contacts.email IS NOT excluded.email OR contacts.name IS NOT excluded.name
            OR contacts.client_id IS NOT excluded.client_id OR contacts.location_id IS NOT excluded.location_id`,
      )
      .bind(r.id, r.email, r.name, r.clientId, r.locationId),
    contactsComplete,
  );
  const deviceStats = await syncTable(env.DB, "devices", "agent_id", deviceRows, (r) => r.agentId, (r) =>
    env.DB
      .prepare(
        `INSERT INTO devices
          (hostname, client_id, location_id, agent_id, asset_num, display_name, serial, local_ip, public_ip, os)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           hostname = excluded.hostname, client_id = excluded.client_id, location_id = excluded.location_id,
           asset_num = excluded.asset_num, display_name = excluded.display_name, serial = excluded.serial,
           local_ip = excluded.local_ip, public_ip = excluded.public_ip, os = excluded.os
         WHERE devices.hostname IS NOT excluded.hostname OR devices.client_id IS NOT excluded.client_id
            OR devices.location_id IS NOT excluded.location_id OR devices.asset_num IS NOT excluded.asset_num
            OR devices.display_name IS NOT excluded.display_name OR devices.serial IS NOT excluded.serial
            OR devices.local_ip IS NOT excluded.local_ip OR devices.public_ip IS NOT excluded.public_ip
            OR devices.os IS NOT excluded.os`,
      )
      .bind(
        r.hostname,
        r.clientId,
        r.locationId,
        r.agentId,
        r.assetNum,
        r.displayName,
        r.serial,
        r.localIp,
        r.publicIp,
        r.os,
      ),
  );

  await setLastSync(env.DB, new Date().toISOString());
  const all = [clientStats, locationStats, contactStats, deviceStats];
  return {
    clients: clientStats.total,
    locations: locationStats.total,
    contacts: contactStats.total,
    devices: deviceStats.total,
    changed: all.reduce((n, s) => n + s.changed, 0),
    deleted: all.reduce((n, s) => n + s.deleted, 0),
    complete: locationsComplete && contactsComplete,
  };
}

/**
 * Collapse rows sharing a key down to one deterministic winner. Gorelo can
 * return the same contact under more than one client (or with a null clientId
 * that falls back to the query's cid), so the raw row list — built by concurrent
 * per-client fetches — can hold several entries for one id in a run-dependent
 * order. Without this, the "last writer wins" upsert flip-flops that row's
 * client/location every sync (endless `changed` churn). Picking the smallest
 * serialization makes the winner stable across runs regardless of fetch order.
 */
function dedupeByKey<T>(rows: T[], keyOf: (row: T) => string | number): T[] {
  const byKey = new Map<string, T>();
  for (const r of rows) {
    const k = String(keyOf(r));
    const cur = byKey.get(k);
    if (cur === undefined || JSON.stringify(r) < JSON.stringify(cur)) byKey.set(k, r);
  }
  return [...byKey.values()];
}

/**
 * Reconcile `table` against `rows` without a full rewrite:
 *  1. Upsert every fetched row (the caller's stmt guards ON CONFLICT on a real
 *     diff, so unchanged rows write nothing).
 *  2. When `canDelete`, read back the surviving keys and DELETE only those that
 *     vanished upstream. `canDelete` is false when the caller's fetch was partial
 *     (a per-client failure) — deleting then would drop rows we merely failed to
 *     fetch, so we upsert-only and let a later complete sync reconcile.
 * Net D1 writes per sync = (new + changed rows) + (removed rows) — zero when the
 * upstream data is unchanged, vs. a full-table rewrite every run before.
 *
 * Returns row counts: `total` (the mirror's actual row count after the sync),
 * `changed` actually written (D1 reports `meta.changes = 0` when the
 * WHERE-guarded upsert is a no-op) and `deleted`.
 */
async function syncTable<T>(
  db: D1Database,
  table: string,
  keyCol: string,
  rows: T[],
  keyOf: (row: T) => string | number,
  toStmt: (row: T) => D1PreparedStatement,
  canDelete = true,
): Promise<TableStats> {
  const deduped = dedupeByKey(rows, keyOf);
  let changed = 0;
  for (const part of chunk(deduped, INSERT_CHUNK)) {
    const stmts = part.map(toStmt);
    if (!stmts.length) continue;
    const res = await db.batch(stmts);
    for (const r of res) changed += r.meta?.changes ?? 0;
  }

  // Current mirror keys (post-upsert). Reading keys is cheap (D1 bills reads far
  // below writes) and also yields the true post-sync row count for `total`.
  const { results } = await db.prepare(`SELECT ${keyCol} AS k FROM ${table}`).all<{ k: unknown }>();
  const dbKeys = (results ?? []).map((row) => row.k).filter((k) => k != null) as (string | number)[];

  let deleted = 0;
  if (canDelete) {
    // Reconcile deletes: keys present in D1 but no longer returned by Gorelo.
    // Usually empty, so a steady-state sync issues no DELETE batches at all.
    const fetched = new Set<string>(deduped.map((r) => String(keyOf(r))));
    const stale = dbKeys.filter((k) => !fetched.has(String(k)));
    for (const part of chunk(stale, INSERT_CHUNK)) {
      if (!part.length) continue;
      const placeholders = part.map(() => "?").join(", ");
      await db.batch([db.prepare(`DELETE FROM ${table} WHERE ${keyCol} IN (${placeholders})`).bind(...part)]);
    }
    deleted = stale.length;
  }
  return { total: dbKeys.length - deleted, changed, deleted };
}
