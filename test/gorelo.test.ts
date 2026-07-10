import { describe, expect, it } from "vitest";
import { retryDelayMs } from "../src/gorelo.js";

const withRetryAfter = (value: string | null): Response =>
  new Response("", { status: 429, headers: value == null ? {} : { "retry-after": value } });

describe("retryDelayMs", () => {
  it("honors a numeric Retry-After (delta-seconds)", () => {
    expect(retryDelayMs(withRetryAfter("5"), 1)).toBe(5000);
  });

  it("honors an HTTP-date Retry-After", () => {
    const when = new Date(Date.now() + 4000).toUTCString(); // ~4s out
    const ms = retryDelayMs(withRetryAfter(when), 1);
    // Allow for sub-second clock drift between building the date and reading it.
    expect(ms).toBeGreaterThan(2500);
    expect(ms).toBeLessThanOrEqual(4000);
  });

  it("caps an over-long Retry-After", () => {
    expect(retryDelayMs(withRetryAfter("9999"), 1)).toBe(15_000);
  });

  it("treats a negative Retry-After as no wait", () => {
    expect(retryDelayMs(withRetryAfter("-5"), 1)).toBe(0);
  });

  it("falls back to exponential backoff (with jitter) when no header", () => {
    // attempt 1 -> base 500ms; jitter adds [0,250).
    const ms = retryDelayMs(withRetryAfter(null), 1);
    expect(ms).toBeGreaterThanOrEqual(500);
    expect(ms).toBeLessThan(750);
    // attempt 3 -> base 2000ms.
    const ms3 = retryDelayMs(withRetryAfter(null), 3);
    expect(ms3).toBeGreaterThanOrEqual(2000);
    expect(ms3).toBeLessThan(2250);
  });

  it("caps exponential backoff at 8s (+jitter) for high attempt counts", () => {
    const ms = retryDelayMs(withRetryAfter(null), 10);
    expect(ms).toBeGreaterThanOrEqual(8000);
    expect(ms).toBeLessThan(8250);
  });

  it("falls back to backoff when Retry-After is unparseable", () => {
    const ms = retryDelayMs(withRetryAfter("soon"), 1);
    expect(ms).toBeGreaterThanOrEqual(500);
    expect(ms).toBeLessThan(750);
  });
});
