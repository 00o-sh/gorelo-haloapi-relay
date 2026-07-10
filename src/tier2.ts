import type { Env } from "./types.js";

/** Tier2Tickets cloud posts from these two fixed source IPs. */
export const TIER2_SOURCE_IPS = new Set(["34.202.14.153", "3.209.57.193"]);

/**
 * True if the request is from an allowlisted Tier2 IP (or the allowlist is
 * explicitly disabled). Fails closed (audit F2): the allowlist is ENFORCED by
 * default. Only an explicit, normalized `"false"`, `"0"`, or `""` disables it —
 * an unset var, `"true"`, `"True"`, or any other value enforces. The
 * `CF-Connecting-IP` check is exact-match; the header is Cloudflare-controlled
 * and an absent header already fails closed (empty string is not in the set).
 */
export function ipAllowed(request: Request, env: Env): boolean {
  const raw = env.ENFORCE_IP_ALLOWLIST;
  if (raw !== undefined) {
    const flag = raw.trim().toLowerCase();
    if (flag === "false" || flag === "0" || flag === "") return true; // explicitly disabled
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  return TIER2_SOURCE_IPS.has(ip);
}
