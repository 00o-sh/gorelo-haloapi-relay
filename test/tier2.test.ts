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
});
