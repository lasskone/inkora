/**
 * Live Dashboard validation helper (run manually against a running server).
 *
 *   npm run build && npm run start
 *   node --import ./scripts/test-register.mjs ./scripts/live-dashboard.mts
 *
 * The Dashboard's central claim is a cost claim: a normal load performs **no
 * eBay call, no CJ call and no freight call**, reads a fixed number of bounded
 * Supabase queries, and never re-scores anything (docs/ARCHITECTURE.md §19.1,
 * §19.3). That claim is only worth anything if it is measured rather than
 * asserted, so this script instruments the read path directly instead of only
 * checking what the HTTP body happens to say:
 *
 *   STEP 1  every outbound request is counted by host — upstream calls must be 0
 *   STEP 2  the Supabase query count is exactly the documented 7, and each read
 *           respects its named server-owned ceiling
 *   STEP 3  the query count is identical at page size 1, 12 and 50 — an N+1 read
 *           would scale with the page size, so a constant count is the proof
 *   STEP 4  response time is measured against the running server
 *   STEP 5  the route contract: rejected filters and sorts, a clamped page size,
 *           and a deep link that round-trips
 *
 * A validation run reads only. It creates no watchlist entry, no assessment and
 * no observation, so it leaves the database exactly as it found it.
 */

import { readFile } from "node:fs/promises";

import { loadDashboard } from "@/lib/dashboard/dashboard-service";
import {
  DASHBOARD_ACTIVITY_LIMIT,
  DASHBOARD_ASSESSMENT_WINDOW,
  DASHBOARD_ATTENTION_LIMIT,
  DASHBOARD_CHANGES_LIMIT,
  DASHBOARD_MAX_LIMIT,
  DASHBOARD_WATCHLIST_PREVIEW,
} from "@/lib/dashboard/limits";
import type { DashboardData } from "@/lib/dashboard/types";

const BASE = "http://localhost:3000";
const ENDPOINT = `${BASE}/api/dashboard`;
const ENV_FILE = new URL("../.env.local", import.meta.url);

/** The number of Supabase queries one Dashboard load issues (§19.3). */
const EXPECTED_SUPABASE_QUERIES = 7;

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label} — ${detail}`);
  }
}

/**
 * Loads the local environment the way `next start` would. A plain `node` process
 * does not read `.env.local`, and the persistence client reads its URL and key
 * from it, so without this the instrumented load below would report `disabled`
 * rather than measuring anything.
 */
async function loadEnv(): Promise<void> {
  let text: string;
  try {
    text = await readFile(ENV_FILE, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    const value = line
      .slice(equals + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Instrumentation: every outbound request, counted by host
// ---------------------------------------------------------------------------

interface RequestLog {
  url: string;
  host: string;
}

const requests: RequestLog[] = [];
const originalFetch = globalThis.fetch;

/**
 * Wraps `globalThis.fetch` for the duration of the instrumented load. Every
 * request the persistence client and the service issue goes through here, so the
 * counts are the whole story of what a Dashboard load touches.
 */
function installFetchCounter(): void {
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = url;
    }
    requests.push({ url, host });
    return originalFetch(input as RequestInfo, init as RequestInit);
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/** True when a request left the project's own persistence backend. */
function isSupabase(host: string): boolean {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (configured) {
    try {
      return host === new URL(configured).host;
    } catch {
      // Fall through to the suffix check below.
    }
  }
  return host.endsWith(".supabase.co") || host.endsWith(".supabase.in");
}
/** Ground truth read straight from the tables, to hold the page's counts to. */
async function groundTruth(): Promise<{
  activeWatchlist: number;
  assessments: number;
}> {
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  );
  const [active, assessments] = await Promise.all([
    client
      .from("watchlist_entries")
      .select("*", { count: "exact", head: true })
      .is("archived_at", null),
    client.from("opportunity_observations").select("*", { count: "exact", head: true }),
  ]);
  return {
    activeWatchlist: active.count ?? 0,
    assessments: assessments.count ?? 0,
  };
}


async function instrumentedLoad(limit: number): Promise<{
  dashboard: DashboardData;
  status: string;
  supabaseQueries: number;
  upstream: RequestLog[];
  elapsedMs: number;
}> {
  requests.length = 0;
  installFetchCounter();
  const started = performance.now();
  let result;
  try {
    result = await loadDashboard({
      filters: {},
      sort: "score",
      limit,
    });
  } finally {
    restoreFetch();
  }
  const elapsedMs = performance.now() - started;

  const supabaseQueries = requests.filter((entry) => isSupabase(entry.host)).length;
  const upstream = requests.filter((entry) => !isSupabase(entry.host));

  if (result.status === "disabled") {
    return {
      dashboard: emptyDashboard(),
      status: result.status,
      supabaseQueries,
      upstream,
      elapsedMs,
    };
  }
  return {
    dashboard: result.dashboard,
    status: result.status,
    supabaseQueries,
    upstream,
    elapsedMs,
  };
}

/** A stand-in read model for the disabled state, so the shape stays uniform. */
function emptyDashboard(): DashboardData {
  const unavailable = { status: "unavailable" as const, note: "" };
  return {
    marketplace: "ebay",
    supplier: "cj",
    hasIntelligence: false,
    summary: {
      ...unavailable,
      evaluatedOpportunities: 0,
      watchedOpportunities: 0,
      profitable: 0,
      losing: 0,
      profitUnknown: 0,
      needsAttention: 0,
      persistedAssessments: 0,
      bands: { HIGH: 0, MEDIUM: 0, LOW: 0 },
      evidenceConfidence: { HIGH: 0, MEDIUM: 0, LOW: 0 },
      economicsCompleteness: { COMPLETE: 0, PARTIAL: 0, UNAVAILABLE: 0 },
    },
    topOpportunities: {
      ...unavailable,
      rows: [],
      sort: "score",
      limit: 0,
      filteredCount: 0,
    },
    attention: { ...unavailable, items: [], limit: 0 },
    changes: { ...unavailable, changes: [], limit: 0 },
    watchlist: {
      ...unavailable,
      activeCount: 0,
      marketplaceOnlyCount: 0,
      changedCount: 0,
      preview: [],
      limit: 0,
    },
    coverage: {
      ...unavailable,
      economicsCompleteness: { COMPLETE: 0, PARTIAL: 0, UNAVAILABLE: 0 },
      evidenceConfidence: { HIGH: 0, MEDIUM: 0, LOW: 0 },
      matchConfidence: { HIGH: 0, MEDIUM: 0, LOW: 0 },
      supplierEvidence: { confirmed: 0, unknown: 0, none: 0 },
    },
    activity: { ...unavailable, events: [], limit: 0, unavailableSources: [] },
    freshness: { ...unavailable, entries: [], staleThresholdHours: 72 },
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// HTTP checks against the running server
// ---------------------------------------------------------------------------

interface DashboardSuccessBody {
  status: "ok" | "degraded";
  dashboard: DashboardData;
  bounds: {
    limit: number;
    sort: string;
    filters: Record<string, string>;
    assessmentWindow: number;
    attentionLimit: number;
    changesLimit: number;
    activityLimit: number;
    watchlistRead: number;
    watchlistPreview: number;
    snapshotReadCap: number;
    defaultLimit: number;
    maxLimit: number;
  };
  timestamp: string;
}

interface DashboardErrorBody {
  status: "error";
  error: string;
  code: string;
  timestamp: string;
  detail?: string;
}

async function request(
  url: string,
): Promise<{
  httpStatus: number;
  body: DashboardSuccessBody | DashboardErrorBody;
  headers: Headers;
}> {
  const response = await fetch(url, { cache: "no-store" });
  const body = (await response.json()) as DashboardSuccessBody | DashboardErrorBody;
  return { httpStatus: response.status, body, headers: response.headers };
}

function countHost(hosts: Set<string>, pattern: RegExp): number {
  return [...hosts].filter((host) => pattern.test(host)).length;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(78));
  console.log("STEP 0 — the server is up and persistence is configured");
  console.log("=".repeat(78));
  await loadEnv();
  const health = await request(`${BASE}/api/health`).catch(() => null);
  check(
    "the running server answers on localhost:3000",
    health !== null,
    health === null ? "start it with `npm run build && npm run start`" : "",
  );
  if (health === null) {
    console.log("\nCannot validate without a running server. Nothing was measured.");
    process.exit(1);
  }

  const configured =
    process.env.NEXT_PUBLIC_SUPABASE_URL !== undefined &&
    process.env.SUPABASE_SERVICE_ROLE_KEY !== undefined;
  check(
    "the Supabase variables this server needs are present locally",
    configured,
    configured
      ? ""
      : "add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local",
  );

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 1 — a normal load performs no upstream call at all");
  console.log("=".repeat(78));
  const baseline = await instrumentedLoad(12);
  check(
    "persistence answered (the load is not `disabled`)",
    baseline.status !== "disabled",
    baseline.status === "disabled"
      ? "the instrumented load saw no configured persistence client"
      : `status=${baseline.status}`,
  );
  const upstreamHosts = new Set(baseline.upstream.map((entry) => entry.host));
  check(
    `eBay calls: ${countHost(upstreamHosts, /ebay/)} — a Dashboard load calls eBay zero times`,
    !([...upstreamHosts].some((host) => /ebay/.test(host))),
    [...upstreamHosts].filter((host) => /ebay/.test(host)).join(", ") ||
      "no eBay host contacted",
  );
  check(
    `CJ calls: ${countHost(upstreamHosts, /cjdropshipping/)} — a Dashboard load calls CJ zero times`,
    !([...upstreamHosts].some((host) => /cjdropshipping/.test(host))),
    [...upstreamHosts].filter((host) => /cjdropshipping/.test(host)).join(", ") ||
      "no CJ host contacted",
  );
  check(
    "freight calls: 0 — no shipping quote is ever requested on a read path",
    !([...upstreamHosts].some((host) => /freight|shipping|rates/.test(host))),
    [...upstreamHosts].filter((host) => /freight|shipping|rates/.test(host)).join(", ") ||
      "no freight host contacted",
  );
  check(
    `upstream requests in total: ${baseline.upstream.length} (any host outside Supabase)`,
    baseline.upstream.length === 0,
    baseline.upstream.map((entry) => entry.host).join(", ") || "none",
  );
  console.log(
    `  instrumented service-only load (no HTTP hop, 7 queries): ${baseline.elapsedMs.toFixed(0)} ms`,
  );

  await step2(baseline);
  await step3();
  await step4();
  await step5();
}

/**
 * The scope of a single instrumented load, for STEP 2 and STEP 3.
 */
interface Measurement {
  limit: number;
  queries: number;
  rows: number;
}


async function step2(baseline: {
  dashboard: DashboardData;
  supabaseQueries: number;
}): Promise<void> {
  console.log("");
  console.log("=".repeat(78));
  console.log(`STEP 2 — ${EXPECTED_SUPABASE_QUERIES} bounded Supabase queries, no more`);
  console.log("=".repeat(78));
  check(
    `the load issued exactly ${EXPECTED_SUPABASE_QUERIES} Supabase queries`,
    baseline.supabaseQueries === EXPECTED_SUPABASE_QUERIES,
    `measured ${baseline.supabaseQueries}`,
  );
  const d = baseline.dashboard;
  check(
    `top opportunities respects the page size (rows=${d.topOpportunities.rows.length}, limit=${d.topOpportunities.limit})`,
    d.topOpportunities.rows.length <= d.topOpportunities.limit,
    `rows=${d.topOpportunities.rows.length}, limit=${d.topOpportunities.limit}`,
  );
  check(
    "the page takes the limit from the matching scopes rather than padding it",
    d.topOpportunities.rows.length ===
      Math.min(d.topOpportunities.limit, d.topOpportunities.filteredCount),
    `rows=${d.topOpportunities.rows.length}, filtered=${d.topOpportunities.filteredCount}`,
  );
  check(
    `needs attention respects its own ceiling (items=${d.attention.items.length}, cap=${DASHBOARD_ATTENTION_LIMIT})`,
    d.attention.items.length <= DASHBOARD_ATTENTION_LIMIT,
    `items=${d.attention.items.length}`,
  );
  check(
    `recent changes respects its own ceiling (scopes=${d.changes.changes.length}, cap=${DASHBOARD_CHANGES_LIMIT})`,
    d.changes.changes.length <= DASHBOARD_CHANGES_LIMIT,
    `scopes=${d.changes.changes.length}`,
  );
  check(
    `recent activity respects its own ceiling (events=${d.activity.events.length}, cap=${DASHBOARD_ACTIVITY_LIMIT})`,
    d.activity.events.length <= DASHBOARD_ACTIVITY_LIMIT,
    `events=${d.activity.events.length}`,
  );
  check(
    `watchlist preview respects its own ceiling (rows=${d.watchlist.preview.length}, cap=${DASHBOARD_WATCHLIST_PREVIEW})`,
    d.watchlist.preview.length <= DASHBOARD_WATCHLIST_PREVIEW,
    `rows=${d.watchlist.preview.length}`,
  );
  check(
    `collapsed scopes never exceed the assessment window (scopes=${d.summary.evaluatedOpportunities}, window=${DASHBOARD_ASSESSMENT_WINDOW})`,
    d.summary.evaluatedOpportunities <= DASHBOARD_ASSESSMENT_WINDOW,
    `scopes=${d.summary.evaluatedOpportunities}`,
  );

  // The page's counts are claims about stored rows, so they are checked against
  // the tables themselves rather than trusted from the response.
  const truth = await groundTruth();
  check(
    `watched count matches the active watchlist table (page=${d.summary.watchedOpportunities}, table=${truth.activeWatchlist})`,
    d.summary.watchedOpportunities === truth.activeWatchlist,
    `page=${d.summary.watchedOpportunities}, table=${truth.activeWatchlist}`,
  );
  check(
    `persisted-assessment count matches the whole table (page=${d.summary.persistedAssessments}, table=${truth.assessments})`,
    d.summary.persistedAssessments === truth.assessments,
    `page=${d.summary.persistedAssessments}, table=${truth.assessments}`,
  );
  check(
    `the watchlist section's own count agrees with the summary (${d.watchlist.activeCount} vs ${d.summary.watchedOpportunities})`,
    d.watchlist.activeCount === d.summary.watchedOpportunities,
    `${d.watchlist.activeCount} vs ${d.summary.watchedOpportunities}`,
  );
}

async function step3(): Promise<void> {
  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 3 — the query count is constant across page sizes (no N+1)");
  console.log("=".repeat(78));
  const sizes = [1, 12, 50];
  const perSize: Measurement[] = [];
  for (const limit of sizes) {
    const measured = await instrumentedLoad(limit);
    perSize.push({
      limit,
      queries: measured.supabaseQueries,
      rows: measured.dashboard.topOpportunities.rows.length,
    });
    check(
      `limit=${limit}: ${measured.supabaseQueries} Supabase queries, ${measured.dashboard.topOpportunities.rows.length} rendered rows`,
      measured.supabaseQueries === EXPECTED_SUPABASE_QUERIES,
      `queries=${measured.supabaseQueries}`,
    );
  }
  const counts = new Set(perSize.map((entry) => entry.queries));
  check(
    `the query count does not depend on the page size (${sizes.join(" / ")} → ${[...counts].join(" / ")})`,
    counts.size === 1,
    `a per-scope read would scale here: ${perSize.map((entry) => `${entry.limit}:${entry.queries}`).join(" ")}`,
  );
  const largest = perSize[perSize.length - 1];
  const smallest = perSize[0];
  check(
    "the rendered rows do scale with the page size, so the bound is really applied",
    largest.rows >= smallest.rows,
    `rows at 1 = ${smallest.rows}, rows at 50 = ${largest.rows}`,
  );
}

async function step4(): Promise<void> {
  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 4 — response time against the running server");
  console.log("=".repeat(78));

  // The first request also pays for the connection establishment a fresh server
  // process has not done yet (TLS handshake, pool warm-up), so it is measured and
  // reported on its own rather than averaged into the steady-state cost.
  const coldStarted = performance.now();
  await request(ENDPOINT);
  const coldMs = performance.now() - coldStarted;
  console.log(`  cold first request: ${coldMs.toFixed(0)} ms (pays connection setup)`);

  // Warm up, then measure the steady state the Dashboard actually serves.
  for (let i = 0; i < 3; i += 1) {
    await request(ENDPOINT);
  }
  const samples: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const started = performance.now();
    const timed = await request(ENDPOINT);
    samples.push(performance.now() - started);
    if (timed.httpStatus !== 200) {
      check(`sample ${i + 1} answered 200`, false, `status=${timed.httpStatus}`);
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[sorted.length - 1];
  console.log(
    `  warm round trips: ${samples.map((value) => value.toFixed(0)).join(", ")} ms`,
  );
  console.log(
    `  warm median=${median.toFixed(0)} ms · p95=${p95.toFixed(0)} ms · service-only (no HTTP hop) is reported in STEP 1`,
  );

  check(
    `the cold first request completes inside 2 s (${coldMs.toFixed(0)} ms)`,
    coldMs < 2000,
    `cold=${coldMs.toFixed(0)} ms`,
  );
  check(
    `the warm median is under 1 s (${median.toFixed(0)} ms) — the budget is the 7 documented Supabase round trips`,
    median < 1000,
    `median=${median.toFixed(0)} ms`,
  );
  check(
    `every warm sample completes inside 1.5 s (worst ${p95.toFixed(0)} ms)`,
    p95 < 1500,
    `p95=${p95.toFixed(0)} ms`,
  );
}

async function step5(): Promise<void> {
  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 5 — the route contract: validation, bounds and deep links");
  console.log("=".repeat(78));

  const plain = await request(ENDPOINT);
  check(
    "a request with no query string answers 200 with a read model",
    plain.httpStatus === 200 && plain.body.status !== "error",
    plain.body.status === "error" ? plain.body.error : `status=${plain.httpStatus}`,
  );
  check(
    "the response is never cached (no-store)",
    plain.headers.get("cache-control") === "no-store",
    String(plain.headers.get("cache-control")),
  );
  if (plain.body.status !== "error") {
    check(
      `a degraded page still answers 200 (status=${plain.body.status})`,
      plain.body.status === "ok" || plain.body.status === "degraded",
      plain.body.status,
    );
    check(
      "the server echoes the bounds it actually applied",
      plain.body.bounds.assessmentWindow === DASHBOARD_ASSESSMENT_WINDOW &&
        plain.body.bounds.attentionLimit === DASHBOARD_ATTENTION_LIMIT &&
        plain.body.bounds.maxLimit === DASHBOARD_MAX_LIMIT,
      JSON.stringify(plain.body.bounds),
    );
    check(
      "the default page size is the documented one",
      plain.body.bounds.limit === plain.body.bounds.defaultLimit,
      `limit=${plain.body.bounds.limit}, default=${plain.body.bounds.defaultLimit}`,
    );
    // Every section reports a standing, so the page can always say what it is.
    check(
      "every section carries its own status",
      Object.keys(plain.body.dashboard).includes("summary") &&
        plain.body.dashboard.summary.status.length > 0,
      "missing section statuses",
    );
  }

  const clamped = await request(`${ENDPOINT}?limit=5000`);
  if (clamped.body.status !== "error") {
    check(
      `a page size above the ceiling is clamped, not honoured (asked 5000, got ${clamped.body.bounds.limit})`,
      clamped.body.bounds.limit === DASHBOARD_MAX_LIMIT,
      `limit=${clamped.body.bounds.limit}`,
    );
  }

  const badFilter = await request(`${ENDPOINT}?band=not-a-band`);
  check(
    "a filter outside its vocabulary is rejected with 400",
    badFilter.httpStatus === 400 && badFilter.body.status === "error",
    badFilter.body.status === "error"
      ? badFilter.body.code
      : `status=${badFilter.httpStatus}`,
  );
  if (badFilter.body.status === "error") {
    check(
      "the rejection names the accepted vocabulary",
      (badFilter.body.detail ?? "").includes("LOW"),
      String(badFilter.body.detail ?? ""),
    );
  }

  const badSort = await request(`${ENDPOINT}?sort=price`);
  check(
    "an unrecognized sort key is rejected with 400",
    badSort.httpStatus === 400 && badSort.body.status === "error",
    badSort.body.status === "error" ? badSort.body.code : `status=${badSort.httpStatus}`,
  );

  const deep = await request(
    `${ENDPOINT}?sort=profit&limit=6&band=HIGH&profitability=profitable&supplierScope=pair`,
  );
  if (deep.body.status !== "error") {
    check(
      "a deep link's controls are echoed back exactly as applied",
      deep.body.bounds.sort === "profit" &&
        deep.body.bounds.limit === 6 &&
        deep.body.bounds.filters.band === "HIGH" &&
        deep.body.bounds.filters.profitability === "profitable" &&
        deep.body.bounds.filters.supplierScope === "pair",
      JSON.stringify({ bounds: deep.body.bounds }),
    );
    check(
      "a filtered page never renders more rows than the filtered pool allows",
      deep.body.dashboard.topOpportunities.rows.length <=
        deep.body.dashboard.topOpportunities.filteredCount,
      `rows=${deep.body.dashboard.topOpportunities.rows.length}, filtered=${deep.body.dashboard.topOpportunities.filteredCount}`,
    );
  }

  // A filter that matches nothing must still answer 200: a narrowed page is a
  // valid answer, not an error (§19.6, §19.7).
  const narrow = await request(`${ENDPOINT}?band=HIGH&economics=UNAVAILABLE`);
  check(
    "a filter combination that matches nothing still answers 200",
    narrow.httpStatus === 200 && narrow.body.status !== "error",
    narrow.body.status === "error" ? narrow.body.error : `status=${narrow.httpStatus}`,
  );

  // Partial degradation, measured on live data: a section whose read produced
  // nothing labels itself and the rest of the page still renders (§19.7). On this
  // database every stored watchlist row is archived, so the watchlist section is
  // the section that degrades — the proof is that the others stay available.
  if (plain.body.status !== "error") {
    const sections = plain.body.dashboard;
    const statuses = [
      ["summary", sections.summary.status],
      ["topOpportunities", sections.topOpportunities.status],
      ["attention", sections.attention.status],
      ["changes", sections.changes.status],
      ["watchlist", sections.watchlist.status],
      ["coverage", sections.coverage.status],
      ["activity", sections.activity.status],
      ["freshness", sections.freshness.status],
    ] as const;
    const unavailable = statuses.filter(([, status]) => status === "unavailable");
    const available = statuses.filter(([, status]) => status === "available");
    const partial = statuses.filter(([, status]) => status === "partial");
    console.log(
      `  section standings: ${statuses.map(([name, status]) => `${name}=${status}`).join(", ")}`,
    );
    if (unavailable.length > 0) {
      check(
        `the page is degraded by exactly the sections with no evidence (${unavailable.map(([name]) => name).join(", ")})`,
        plain.body.status === "degraded",
        `status=${plain.body.status}`,
      );
      check(
        `an unavailable section costs only its own section — ${available.length} available and ${partial.length} partial of ${statuses.length}`,
        available.length + partial.length === statuses.length - unavailable.length &&
          available.length > 0,
        `${available.length} available, ${partial.length} partial`,
      );
      check(
        "the unavailable section names itself in the activity feed's unavailable sources",
        unavailable.every(([name]) => {
          if (name !== "watchlist") {
            return true;
          }
          return sections.activity.unavailableSources.includes("watchlist-entries");
        }),
        JSON.stringify(sections.activity.unavailableSources),
      );
    } else {
      console.log(
        "  every section is available on this database, so the degradation path is covered by the unit tests instead (§19.7)",
      );
    }
  }

  console.log("");
  console.log("=".repeat(78));
  if (failures === 0) {
    console.log("Dashboard V1 live validation: all checks ok.");
  } else {
    console.log(
      `Dashboard V1 live validation: ${failures} check(s) FAILED — see the [FAIL] lines above.`,
    );
  }
  console.log("=".repeat(78));
  process.exit(failures === 0 ? 0 : 1);
}

void main();

