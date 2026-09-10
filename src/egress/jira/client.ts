import { breadcrumb } from "../../core/log.js";
import { retryDelayMs, stripTrailingSlashes } from "../../core/gorelo.js";
import type { Env } from "../../core/types.js";

/**
 * Jira Cloud client + target config for the egress fan-out (co-managed clients).
 *
 * This module knows nothing about the ingress side — no Halo, no Huntress, no ticket
 * source. It receives generic ticket events (via the subscriber) and mirrors them into
 * a co-managed client's own Jira Cloud, closing the Jira issue when the ticket resolves.
 *
 * Enrollment is per Gorelo client: a client is "send to Jira" exactly when JIRA_TARGETS
 * carries an entry for its clientId. All tenant credentials live in that single Worker
 * secret (never in D1, never logged), the same single-secret pattern NOTIFLY_URLS uses.
 */

/**
 * How a target authenticates to Jira Cloud. Both are ordinary Atlassian account
 * credentials — Jira Cloud has no per-app service identity separate from an
 * account — so **the account behind either mode should be a dedicated Atlassian
 * service account** (support.atlassian.com/user-management/docs/understand-service-accounts/),
 * never a real employee's personal login: a service account has no password, isn't
 * tied to anyone leaving, and doesn't count against the site's user-license seats.
 *
 * - `basic` — email + API token, sent as `Authorization: Basic base64(email:token)`
 *   directly against the site's own `baseUrl`. Simplest to set up; the token is
 *   generated at id.atlassian.com under whichever account (ideally the service
 *   account) is logged in.
 * - `oauth` — a service account's OAuth 2.0 credential (client id/secret), created
 *   in Atlassian Administration → Directory → Service accounts → Create credentials
 *   → OAuth 2.0. Exchanged via `client_credentials` at `auth.atlassian.com` for a
 *   short-lived bearer token — no redirect/consent step, genuine machine-to-machine
 *   auth. Requests go through `api.atlassian.com/ex/jira/{cloudId}/...` instead of
 *   the site directly, so the client resolves `cloudId` once (cached per instance)
 *   via the token's accessible-resources.
 */
export type JiraAuth =
  | { mode: "basic"; email: string; apiToken: string }
  | { mode: "oauth"; oauthClientId: string; oauthClientSecret: string };

/** One co-managed client's Jira destination, from the JIRA_TARGETS secret. */
export interface JiraTarget {
  /** Gorelo client id this target routes for (the enrollment key). */
  clientId: number;
  /**
   * Jira Cloud site base URL, e.g. "https://acme.atlassian.net". Always required:
   * `basic` mode calls it directly; `oauth` mode uses it only to pick the right
   * `cloudId` out of the service account's accessible resources.
   */
  baseUrl: string;
  /** Project key new issues are created under, e.g. "SEC". */
  projectKey: string;
  /** Issue type name, e.g. "Task" / "Incident" (default "Task"). */
  issueType: string;
  /**
   * Transition NAME to move the issue to on a ticket resolution, e.g. "Done".
   * Matched case-insensitively against the issue's available transitions. Unset
   * skips the transition (a resolution comment is still added).
   */
  resolvedTransition?: string;
  auth: JiraAuth;
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

    // Two auth shapes can appear on one entry; `basic` is checked first only as a
    // tie-break if both are somehow fully present — pick one mode per client.
    const email = strField(o, "email");
    const apiToken = typeof o.apiToken === "string" ? o.apiToken : "";
    const oauthClientId = strField(o, "oauthClientId");
    const oauthClientSecret = typeof o.oauthClientSecret === "string" ? o.oauthClientSecret : "";
    let auth: JiraAuth | null = null;
    if (email && apiToken) auth = { mode: "basic", email, apiToken };
    else if (oauthClientId && oauthClientSecret) auth = { mode: "oauth", oauthClientId, oauthClientSecret };

    if (!Number.isFinite(clientId) || !baseUrl || !projectKey || !auth) {
      // Log the client id only (never the token/secret) so a misconfig is visible but safe.
      breadcrumb(`JIRA_TARGETS entry skipped (missing field) clientId=${o.clientId ?? "?"}`);
      continue;
    }
    out.set(clientId, {
      clientId,
      baseUrl,
      projectKey,
      issueType: strField(o, "issueType") || "Task",
      resolvedTransition: strField(o, "resolvedTransition") || undefined,
      auth,
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

/** Fields for a new Jira issue (already flattened from the ticket event). */
export interface JiraIssueInput {
  summary: string;
  /** Plain text; wrapped into ADF by the client. */
  description: string;
  labels?: string[];
}

const OAUTH_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
// Refresh this many ms before the token's real expiry so a request never races it.
const OAUTH_REFRESH_SKEW_MS = 60_000;

/**
 * Thin, dependency-free Jira Cloud REST client, scoped to one target. Mirrors the
 * discipline of GoreloClient: keeps credentials out of logs (Authorization is never
 * logged) and backs off on 429/5xx using the shared retryDelayMs schedule.
 *
 * In `oauth` mode the access token and resolved `cloudId` are cached on the instance
 * (not across requests/invocations — Workers give no such guarantee) so one create-then-
 * close sequence within the same fan-out only pays the token/cloudId lookup once.
 */
export class JiraClient {
  private accessToken?: string;
  private accessTokenExpiresAt = 0; // epoch ms
  private cloudId?: string;

  constructor(private readonly target: JiraTarget) {}

  /**
   * client_credentials exchange for an `oauth`-mode target — true machine-to-machine
   * auth (no redirect/consent), specific to Atlassian service-account OAuth 2.0
   * credentials. Cached until `OAUTH_REFRESH_SKEW_MS` before the real expiry.
   */
  private async ensureAccessToken(): Promise<string> {
    if (this.target.auth.mode !== "oauth") {
      throw new Error("ensureAccessToken called on a non-oauth Jira target");
    }
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt) return this.accessToken;

    const { oauthClientId, oauthClientSecret } = this.target.auth;
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: oauthClientId,
        client_secret: oauthClientSecret,
      }),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new JiraError("Jira OAuth token request failed", res.status, text);
    let parsed: { access_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    } catch {
      throw new JiraError("Jira OAuth token response was not JSON", res.status, text);
    }
    if (!parsed.access_token) throw new JiraError("Jira OAuth token response carried no access_token", res.status, text);

    this.accessToken = parsed.access_token;
    const ttlMs = (parsed.expires_in ?? 3600) * 1000;
    this.accessTokenExpiresAt = now + Math.max(ttlMs - OAUTH_REFRESH_SKEW_MS, 0);
    return this.accessToken;
  }

  /**
   * `oauth`-mode requests go through `api.atlassian.com/ex/jira/{cloudId}`, not the
   * site directly — resolve which accessible resource matches this target's `baseUrl`
   * (the service account's OAuth credential may have scopes on several sites).
   */
  private async resolveCloudId(): Promise<string> {
    if (this.cloudId) return this.cloudId;
    const token = await this.ensureAccessToken();
    const res = await fetch(ACCESSIBLE_RESOURCES_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new JiraError("Jira accessible-resources lookup failed", res.status, text);
    let resources: Array<{ id?: string; url?: string }>;
    try {
      resources = JSON.parse(text) as Array<{ id?: string; url?: string }>;
    } catch {
      throw new JiraError("Jira accessible-resources response was not JSON", res.status, text);
    }
    const wanted = stripTrailingSlashes(this.target.baseUrl).toLowerCase();
    const match = resources.find((r) => stripTrailingSlashes(r.url ?? "").toLowerCase() === wanted);
    if (!match?.id) {
      throw new JiraError(
        `service account has no access to ${this.target.baseUrl} (check its OAuth credential's site scopes)`,
        res.status,
        text,
      );
    }
    this.cloudId = match.id;
    return this.cloudId;
  }

  private async authHeader(): Promise<string> {
    if (this.target.auth.mode === "basic") {
      // btoa is available in the Workers runtime. email:token is the Jira Cloud
      // basic-auth credential; never logged.
      const { email, apiToken } = this.target.auth;
      return `Basic ${btoa(`${email}:${apiToken}`)}`;
    }
    return `Bearer ${await this.ensureAccessToken()}`;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    // Sequential, not Promise.all: authHeader() warms the oauth token cache first,
    // so the resolveCloudId() inside baseUrl() below reuses it instead of racing a
    // second concurrent token fetch.
    const auth = await this.authHeader();
    const base = this.target.auth.mode === "basic" ? this.target.baseUrl : `https://api.atlassian.com/ex/jira/${await this.resolveCloudId()}`;
    return fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: auth,
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
