import { breadcrumb } from "./log.js";
import { retryDelayMs, stripTrailingSlashes } from "./gorelo.js";
import type { Env } from "./types.js";

/**
 * Jira output (co-managed clients). The relay's primary job is creating Gorelo
 * tickets from Huntress alerts; this module fans a copy of a Huntress alert out to
 * a co-managed client's own Jira Cloud, and closes the Jira issue when Huntress
 * later resolves the incident. It is strictly additive — a Jira failure never
 * affects the Gorelo create (the fan-out runs in the request's waitUntil, and a
 * failure is queued for the cron flush, mirroring the pending_tickets path).
 *
 * Enrollment is per Gorelo client: a client is "co-managed / send to Jira" exactly
 * when JIRA_TARGETS carries an entry for its clientId. All tenant credentials live
 * in that single Worker secret (never in D1, never logged), the same single-secret
 * pattern NOTIFLY_URLS uses.
 */

/** One co-managed client's Jira destination, from the JIRA_TARGETS secret. */
export interface JiraTarget {
  /** Gorelo client id this target routes for (the enrollment key). */
  clientId: number;
  /** Jira Cloud site base URL, e.g. "https://acme.atlassian.net". */
  baseUrl: string;
  /** Project key new issues are created under, e.g. "SEC". */
  projectKey: string;
  /** Issue type name, e.g. "Task" / "Incident" (default "Task"). */
  issueType: string;
  /** Jira account email for basic auth (paired with an API token). */
  email: string;
  /** Jira API token (basic-auth password). Kept out of logs. */
  apiToken: string;
  /**
   * Transition NAME to move the issue to on a Huntress resolution, e.g. "Done".
   * Matched case-insensitively against the issue's available transitions. Unset
   * skips the transition (a resolution comment is still added).
   */
  resolvedTransition?: string;
}

/** Error carrying the upstream Jira HTTP status so the caller can decide to retry. */
export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ENABLE_JIRA gate — same semantics as the ENABLE_* product flags (default off). */
export function jiraEnabled(env: Env): boolean {
  const v = (env.ENABLE_JIRA ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function strField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Parse JIRA_TARGETS (a JSON array in a Worker secret) into a clientId→target map.
 * Malformed JSON or entries missing a required field are skipped with a breadcrumb
 * (never the token) rather than throwing, so one bad entry can't break the fan-out
 * for every other client. Returns an empty map when unset.
 */
export function parseJiraTargets(env: Env): Map<number, JiraTarget> {
  const out = new Map<number, JiraTarget>();
  const raw = (env.JIRA_TARGETS ?? "").trim();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    breadcrumb("JIRA_TARGETS is not valid JSON — Jira fan-out disabled");
    return out;
  }
  if (!Array.isArray(parsed)) {
    breadcrumb("JIRA_TARGETS is not a JSON array — Jira fan-out disabled");
    return out;
  }
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const clientId = Number(o.clientId);
    // Use the O(n) scan (not /\/+$/, which backtracks quadratically on long runs of
    // trailing slashes — this config is external input, so avoid the ReDoS pattern).
    const baseUrl = stripTrailingSlashes(strField(o, "baseUrl"));
    const projectKey = strField(o, "projectKey");
    const email = strField(o, "email");
    const apiToken = typeof o.apiToken === "string" ? o.apiToken : "";
    if (!Number.isFinite(clientId) || !baseUrl || !projectKey || !email || !apiToken) {
      // Log the client id only (never the token) so a misconfig is visible but safe.
      breadcrumb(`JIRA_TARGETS entry skipped (missing field) clientId=${o.clientId ?? "?"}`);
      continue;
    }
    out.set(clientId, {
      clientId,
      baseUrl,
      projectKey,
      issueType: strField(o, "issueType") || "Task",
      email,
      apiToken,
      resolvedTransition: strField(o, "resolvedTransition") || undefined,
    });
  }
  return out;
}

/** The Jira target enrolled for a Gorelo client, or null when not enrolled. */
export function jiraTargetFor(env: Env, clientId: number | null | undefined): JiraTarget | null {
  if (clientId == null) return null;
  return parseJiraTargets(env).get(clientId) ?? null;
}

/**
 * Minimal Atlassian Document Format (ADF) doc for a plain-text body — required by
 * the Jira Cloud v3 create/comment APIs. Each non-empty line becomes a paragraph;
 * a blank line yields an empty paragraph so the source line structure survives.
 */
export function adfDoc(text: string): unknown {
  const lines = (text || "").split("\n");
  const content = lines.map((line) =>
    line.length
      ? { type: "paragraph", content: [{ type: "text", text: line }] }
      : { type: "paragraph" },
  );
  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "doc", version: 1, content };
}

/** Fields for a new Jira issue (already flattened from the Gorelo command). */
export interface JiraIssueInput {
  summary: string;
  /** Plain text; wrapped into ADF by the client. */
  description: string;
  labels?: string[];
}

/**
 * Thin, dependency-free Jira Cloud REST client, scoped to one target. Mirrors the
 * discipline of GoreloClient: keeps the API token out of logs (Authorization is
 * never logged) and backs off on 429/5xx using the shared retryDelayMs schedule.
 */
export class JiraClient {
  constructor(private readonly target: JiraTarget) {}

  private authHeader(): string {
    // btoa is available in the Workers runtime. email:token is the Jira Cloud
    // basic-auth credential; never logged.
    return `Basic ${btoa(`${this.target.email}:${this.target.apiToken}`)}`;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.target.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  }

  /** GET with retry/backoff on 429/5xx (used for the idempotent transitions read). */
  private async getJsonWithRetry<T>(path: string, maxAttempts = 3): Promise<T> {
    let attempt = 0;
    let lastStatus = 0;
    let lastBody = "";
    while (attempt < maxAttempts) {
      const res = await this.request(path, { method: "GET" });
      if (res.ok) return (await res.json()) as T;
      lastStatus = res.status;
      lastBody = await res.text().catch(() => "");
      if (res.status === 429 || res.status >= 500) {
        attempt += 1;
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs(res, attempt));
          continue;
        }
      }
      break;
    }
    throw new JiraError(`GET ${path} failed`, lastStatus, lastBody);
  }

  /**
   * POST /rest/api/3/issue — create an issue, returning its key (e.g. "ACME-123").
   * Single attempt (create is NOT idempotent — a blind retry would duplicate the
   * issue); on failure the caller queues a durable retry that is guarded by the
   * ledger's stored issue key. Throws JiraError with the upstream status on non-2xx.
   */
  async createIssue(input: JiraIssueInput): Promise<string> {
    const body = {
      fields: {
        project: { key: this.target.projectKey },
        issuetype: { name: this.target.issueType },
        summary: input.summary.slice(0, 255), // Jira caps summary length
        description: adfDoc(input.description),
        ...(input.labels?.length ? { labels: input.labels } : {}),
      },
    };
    const res = await this.request("/rest/api/3/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new JiraError("POST /rest/api/3/issue failed", res.status, text);
    let key = "";
    try {
      key = (JSON.parse(text) as { key?: string }).key ?? "";
    } catch {
      /* fall through to the empty-key error below */
    }
    if (!key) throw new JiraError("Jira create returned no issue key", res.status, text);
    return key;
  }

  /** POST a plain-text comment onto an issue. Throws JiraError on non-2xx. */
  async addComment(issueKey: string, text: string): Promise<void> {
    const res = await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: adfDoc(text) }),
    });
    if (!res.ok) {
      const b = await res.text().catch(() => "");
      throw new JiraError(`POST comment on ${issueKey} failed`, res.status, b);
    }
  }

  /** Available workflow transitions for an issue: [{ id, name }]. */
  async getTransitions(issueKey: string): Promise<Array<{ id: string; name: string }>> {
    const data = await this.getJsonWithRetry<{ transitions?: Array<{ id?: string; name?: string }> }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    return (data.transitions ?? [])
      .filter((t): t is { id: string; name: string } => !!t.id && !!t.name)
      .map((t) => ({ id: t.id, name: t.name }));
  }

  /**
   * Transition an issue to the named target status (case-insensitive match against
   * its available transitions). Returns false (no throw) when no matching transition
   * exists — the workflow may simply not offer it from the current status — so a
   * resolution comment can still stand. Throws JiraError only on a transport/API error.
   */
  async transitionTo(issueKey: string, transitionName: string): Promise<boolean> {
    const wanted = transitionName.trim().toLowerCase();
    if (!wanted) return false;
    const transitions = await this.getTransitions(issueKey);
    const match = transitions.find((t) => t.name.trim().toLowerCase() === wanted);
    if (!match) {
      breadcrumb(`JIRA no "${transitionName}" transition available for ${issueKey}`);
      return false;
    }
    const res = await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    if (!res.ok) {
      const b = await res.text().catch(() => "");
      throw new JiraError(`transition ${issueKey} -> ${transitionName} failed`, res.status, b);
    }
    return true;
  }
}
