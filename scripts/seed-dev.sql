-- Synthetic seed for LOCAL development (wrangler dev / Miniflare local D1).
-- Apply with:  npm run db:seed:local   (after `npm run db:migrate:local`)
--
-- This is fake data — NEVER seed real Gorelo mirror data (names/emails/hosts = PHI)
-- into a dev DB. The ids line up with wrangler.toml [vars] (CATCHALL_CLIENT_ID=15567)
-- so routing resolves sensibly offline. Setting sync_meta.last_sync stops the Worker's
-- lazy bootstrap from reaching out to the real Gorelo API on the first request.

-- Clients (customers). 15567 mirrors CATCHALL_CLIENT_ID so unmatched routing has a home.
INSERT OR REPLACE INTO clients (id, name) VALUES
  (10, 'Example Corp'),
  (15567, 'Catch-All (dev)');

-- Locations (sites).
INSERT OR REPLACE INTO locations (id, name, client_id) VALUES
  (100, 'HQ', 10);

-- Contacts (users) — keyed by email for the Halo Users lookup.
INSERT OR REPLACE INTO contacts (id, email, name, client_id, location_id) VALUES
  (55, 'jane@example.com', 'Jane Doe', 10, 100);

-- A device/agent — lets host-based routing (e.g. an alert's host) resolve to a
-- client/location and attach an asset. agent_id is a throwaway synthetic UUID.
INSERT OR REPLACE INTO devices
  (hostname, client_id, location_id, agent_id, asset_num, display_name, serial, local_ip, public_ip, os)
VALUES
  ('db-server-01', 10, 100, '00000000-0000-4000-8000-000000000001', 424242,
   'DB-SERVER-01', 'SN-DEV-0001', '10.0.0.10', '203.0.113.10', 'Windows Server 2022');

-- Stamp a recent sync so ensureSynced() skips the lazy bootstrap sync (which would
-- otherwise call the real Gorelo API and pull real data into your local DB).
INSERT OR REPLACE INTO sync_meta (key, value) VALUES
  ('last_sync', '2026-01-01T00:00:00.000Z');
