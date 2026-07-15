import type { Env } from "./types.js";

/** Tier2Tickets cloud posts from these fixed source IPs (exact match). */
export const TIER2_SOURCE_IPS = new Set([
  "34.202.14.153",
  "3.209.57.193",
  "52.4.130.244",
  "34.205.224.75",
  "184.72.103.99",
  "107.21.187.4",
]);

/** Allowlisted IPv4 CIDR ranges — a source IP inside any range is allowed. */
export const TIER2_SOURCE_CIDRS = ["4.150.82.176/28", "172.200.220.176/28"];

/** Parse a dotted-quad IPv4 string to a 32-bit unsigned int, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

/** True if `ip` falls within the `a.b.c.d/len` IPv4 CIDR range. */
function ipInCidr(ip: string, cidr: string): boolean {
  const [base, lenStr] = cidr.split("/");
  const prefix = Number(lenStr);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base ?? "");
  if (ipInt === null || baseInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * True if the request is from an allowlisted Tier2 IP (or the allowlist is
 * explicitly disabled). Fails closed (audit F2): the allowlist is ENFORCED by
 * default. Only an explicit, normalized `"false"`, `"0"`, or `""` disables it —
 * an unset var, `"true"`, `"True"`, or any other value enforces. The
 * `CF-Connecting-IP` check matches the exact source IPs and the CIDR ranges;
 * the header is Cloudflare-controlled and an absent header already fails closed
 * (empty string is neither in the set nor inside any range).
 */
export function ipAllowed(request: Request, env: Env): boolean {
  const raw = env.ENFORCE_IP_ALLOWLIST;
  if (raw !== undefined) {
    const flag = raw.trim().toLowerCase();
    if (flag === "false" || flag === "0" || flag === "") return true; // explicitly disabled
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  if (TIER2_SOURCE_IPS.has(ip)) return true;
  return TIER2_SOURCE_CIDRS.some((cidr) => ipInCidr(ip, cidr));
}
