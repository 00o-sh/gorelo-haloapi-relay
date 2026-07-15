import { describe, expect, it } from "vitest";
import { ipAllowed, TIER2_SOURCE_IPS } from "../src/tier2.js";
import type { Env } from "../src/types.js";

const ALLOWED_IP = [...TIER2_SOURCE_IPS][0]!;

/** A request carrying (or omitting) a CF-Connecting-IP header. */
function reqFrom(ip?: string): Request {
  const headers = ip ? { "CF-Connecting-IP": ip } : undefined;
  return new Request("https://t2t.example.com/tickets", { headers });
}

/** Minimal Env carrying just the allowlist var (undefined => unset). */
function envWith(value?: string): Env {
  return { ENFORCE_IP_ALLOWLIST: value } as unknown as Env;
}

describe("ipAllowed — fail closed (audit F2)", () => {
  it("ENFORCES when the var is unset (the key F2 fix)", () => {
    expect(ipAllowed(reqFrom(ALLOWED_IP), envWith(undefined))).toBe(true);
    expect(ipAllowed(reqFrom("9.9.9.9"), envWith(undefined))).toBe(false);
    expect(ipAllowed(reqFrom(undefined), envWith(undefined))).toBe(false); // absent header fails closed
  });

  it("ENFORCES on 'true' and any non-disabling value (incl. mixed case)", () => {
    for (const v of ["true", "True", "TRUE", "yes", "on", "1", "enforce"]) {
      expect(ipAllowed(reqFrom("9.9.9.9"), envWith(v))).toBe(false);
      expect(ipAllowed(reqFrom(ALLOWED_IP), envWith(v))).toBe(true);
    }
  });

  it("only disables on an explicit, normalized false / 0 / empty", () => {
    for (const v of ["false", "False", "  FALSE  ", "0", "", "   "]) {
      expect(ipAllowed(reqFrom("9.9.9.9"), envWith(v))).toBe(true);
    }
  });

  it("allows each exact source IP and rejects a near-miss", () => {
    for (const ip of ["52.4.130.244", "34.205.224.75", "184.72.103.99", "107.21.187.4"]) {
      expect(ipAllowed(reqFrom(ip), envWith("true"))).toBe(true);
    }
    expect(ipAllowed(reqFrom("52.4.130.245"), envWith("true"))).toBe(false);
  });

  it("allows IPs inside the /28 CIDR ranges and rejects those just outside", () => {
    // 4.150.82.176/28 -> 4.150.82.176 .. 4.150.82.191
    expect(ipAllowed(reqFrom("4.150.82.176"), envWith("true"))).toBe(true);
    expect(ipAllowed(reqFrom("4.150.82.185"), envWith("true"))).toBe(true);
    expect(ipAllowed(reqFrom("4.150.82.191"), envWith("true"))).toBe(true);
    expect(ipAllowed(reqFrom("4.150.82.175"), envWith("true"))).toBe(false);
    expect(ipAllowed(reqFrom("4.150.82.192"), envWith("true"))).toBe(false);
    // 172.200.220.176/28 -> 172.200.220.176 .. 172.200.220.191
    expect(ipAllowed(reqFrom("172.200.220.176"), envWith("true"))).toBe(true);
    expect(ipAllowed(reqFrom("172.200.220.191"), envWith("true"))).toBe(true);
    expect(ipAllowed(reqFrom("172.200.220.175"), envWith("true"))).toBe(false);
    expect(ipAllowed(reqFrom("172.200.220.192"), envWith("true"))).toBe(false);
  });
});
