import { describe, expect, it } from "vitest";
import { adfDoc, jiraEnabled, jiraTargetFor, parseJiraTargets } from "../src/jira.js";
import type { Env } from "../src/types.js";

// These exercise the pure config/parsing helpers only (no network), so they don't
// need the outbound fetch stub or the D1 seed the halo specs use.
const mkEnv = (over: Partial<Env>): Env => ({ ...over }) as Env;

describe("jiraEnabled", () => {
  it("is off by default / for false-ish values, on for true-ish ones", () => {
    expect(jiraEnabled(mkEnv({}))).toBe(false);
    expect(jiraEnabled(mkEnv({ ENABLE_JIRA: "false" }))).toBe(false);
    expect(jiraEnabled(mkEnv({ ENABLE_JIRA: "" }))).toBe(false);
    for (const v of ["true", "1", "yes", "on", "TRUE", "On"]) {
      expect(jiraEnabled(mkEnv({ ENABLE_JIRA: v }))).toBe(true);
    }
  });
});

describe("parseJiraTargets", () => {
  const good = JSON.stringify([
    {
      clientId: 10,
      baseUrl: "https://acme.atlassian.net/",
      projectKey: "SEC",
      email: "svc@acme.com",
      apiToken: "tok",
      resolvedTransition: "Done",
    },
  ]);

  it("indexes valid entries by clientId, trims the trailing slash, defaults issueType", () => {
    const m = parseJiraTargets(mkEnv({ JIRA_TARGETS: good }));
    const t = m.get(10)!;
    expect(t.baseUrl).toBe("https://acme.atlassian.net"); // trailing slash stripped
    expect(t.projectKey).toBe("SEC");
    expect(t.issueType).toBe("Task"); // defaulted
    expect(t.resolvedTransition).toBe("Done");
  });

  it("skips entries missing a required field but keeps the valid ones", () => {
    const raw = JSON.stringify([
      { clientId: 1 }, // missing everything else
      { clientId: 2, baseUrl: "https://x.atlassian.net", projectKey: "P", email: "e@x.com" }, // no token
      { clientId: 3, baseUrl: "https://y.atlassian.net", projectKey: "Q", email: "e@y.com", apiToken: "t" },
    ]);
    const m = parseJiraTargets(mkEnv({ JIRA_TARGETS: raw }));
    expect(m.has(1)).toBe(false);
    expect(m.has(2)).toBe(false);
    expect(m.has(3)).toBe(true);
  });

  it("returns an empty map for unset / malformed / non-array input", () => {
    expect(parseJiraTargets(mkEnv({})).size).toBe(0);
    expect(parseJiraTargets(mkEnv({ JIRA_TARGETS: "" })).size).toBe(0);
    expect(parseJiraTargets(mkEnv({ JIRA_TARGETS: "{ not json" })).size).toBe(0);
    expect(parseJiraTargets(mkEnv({ JIRA_TARGETS: '{"clientId":1}' })).size).toBe(0); // object, not array
  });

  it("jiraTargetFor returns the target only for an enrolled, non-null client id", () => {
    const e = mkEnv({ JIRA_TARGETS: good });
    expect(jiraTargetFor(e, 10)).not.toBeNull();
    expect(jiraTargetFor(e, 999)).toBeNull();
    expect(jiraTargetFor(e, null)).toBeNull();
    expect(jiraTargetFor(e, undefined)).toBeNull();
  });
});

describe("adfDoc", () => {
  it("wraps each text line in an ADF paragraph, preserving blank lines", () => {
    const doc = adfDoc("first\n\nsecond") as { type: string; content: unknown[] };
    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(3);
    expect(doc.content[0]).toMatchObject({ type: "paragraph", content: [{ type: "text", text: "first" }] });
    expect(doc.content[1]).toEqual({ type: "paragraph" }); // blank line -> empty paragraph
    expect(doc.content[2]).toMatchObject({ content: [{ type: "text", text: "second" }] });
  });

  it("still yields at least one paragraph for empty text", () => {
    const doc = adfDoc("") as { content: unknown[] };
    expect(doc.content).toEqual([{ type: "paragraph" }]);
  });
});
