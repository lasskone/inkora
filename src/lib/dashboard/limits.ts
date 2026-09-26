/**
 * Server-enforced bounds for Dashboard V1 (docs/ARCHITECTURE.md §19.3).
 *
 * The Dashboard is a read surface over append-only tables that grow with every
 * scan and every re-evaluation and are never pruned — they are history
 * (docs/DATABASE.md §7). Every read here is therefore bounded by a named
 * constant, and no client request can raise any of them: the window, the feed
 * bounds and the hard ceiling on one page of results are all server-owned.
 *
 * Worst case for one normal Dashboard load is fixed and knowable in advance:
 *
 * ```text
 *   7 Supabase queries, none of which calls a marketplace, supplier or freight API:
 *     1 assessment window   (≤ DASHBOARD_ASSESSMENT_WINDOW rows)
 *     1 assessment head count (0 rows)
 *     1 active watchlist     (≤ DASHBOARD_WATCHLIST_READ rows)
 *     1 active watchlist head count (0 rows)
 *     1 newest snapshots     (≤ DASHBOARD_ACTIVITY_LIMIT rows)
 *     1 newest seller observations (≤ DASHBOARD_ACTIVITY_LIMIT rows)
 *     1 displayed-product snapshots (≤ DASHBOARD_SNAPSHOT_READ_CAP rows)
 *   eBay calls: 0. CJ calls: 0. Freight calls: 0.
 * ```
 */

/**
 * How many of the most recent persisted assessments the Dashboard reasons over.
 *
 * This is the one bound that needs explaining. An assessment is appended per scope
 * (one marketplace listing × one supplier candidate, or the marketplace-only
 * scope), never updated, so a scope contributes as many rows as it has been
 * evaluated. The Dashboard keeps the newest window of them and collapses it to
 * the *latest assessment per scope* in code — which is how it answers "best
 * opportunities currently known" without a `DISTINCT ON` the REST boundary cannot
 * express, and without scanning the whole table.
 *
 * The honest consequence, stated in the read model itself: a scope whose last
 * assessment falls outside this window is not represented on this page. The
 * window is deliberately generous relative to the other bounds (it feeds the
 * summary, the ranking, the attention derivation, the change comparison, the
 * coverage tallies and part of the activity feed), and it is a hard bound, so the
 * page's worst case stays predictable.
 */
export const DASHBOARD_ASSESSMENT_WINDOW = 250;

/** Assessments shown when the caller names no page size. */
export const DASHBOARD_DEFAULT_LIMIT = 12;

/** Hard ceiling on one page of top opportunities. */
export const DASHBOARD_MAX_LIMIT = 50;

/** Attention items the section will ever render. */
export const DASHBOARD_ATTENTION_LIMIT = 12;

/** Change rows the recent-changes feed will ever render. */
export const DASHBOARD_CHANGES_LIMIT = 12;

/** Events the recent-activity feed will ever render. */
export const DASHBOARD_ACTIVITY_LIMIT = 15;

/**
 * Active entries read to assemble the watchlist summary — deliberately larger
 * than the preview, so the section can count changed and marketplace-only watches
 * accurately even when the preview shows only the newest few.
 */
export const DASHBOARD_WATCHLIST_READ = 48;

/** Rows shown in the watchlist preview. */
export const DASHBOARD_WATCHLIST_PREVIEW = 6;

/**
 * Hard ceiling on the read that supplies titles, images and prices for the
 * products actually displayed. Products accumulate one snapshot per distinct
 * observation, so the read is generous rather than exact; a product whose
 * snapshots exceed the budget simply renders without a title and price, which is
 * the honest degradation — never a wrong value.
 */
export const DASHBOARD_SNAPSHOT_READ_CAP = 400;

/**
 * Bounds a requested page size to the documented ceiling and a sane floor,
 * falling back to the default for anything unusable.
 *
 * Pure on purpose: the bound is a contract worth unit-testing without any
 * database or credentials, and it is enforced again server-side at the route.
 */
export function clampDashboardLimit(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return DASHBOARD_DEFAULT_LIMIT;
  }
  const bounded = Math.trunc(requested);
  return Math.min(Math.max(bounded, 1), DASHBOARD_MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Wall-clock bounds — a hung read must become a degraded section, never a
// spinner that never ends (docs/ARCHITECTURE.md §19.7).
// ---------------------------------------------------------------------------

/**
 * The wall-clock budget for one persisted Dashboard read.
 *
 * Persistence is the Dashboard's *only* external dependency, and the Supabase
 * client is built without a request timeout by design (`createPersistenceClient`
 * passes none, so the option stays off for every other reader too). Without a
 * bound here, one request that neither resolves nor rejects — a network path
 * that went silent, a pooled connection that was reaped mid-request, or
 * PostgREST's own retry loop on a cold schema cache — leaves the read pending
 * forever. `Promise.all` would then never settle, the route would never answer,
 * and the page would stay on its reading state indefinitely with no error and
 * no crash: exactly the failure a bounded timeout exists to make impossible.
 *
 * Generous on purpose — a normal load reads the whole model in well under two
 * seconds — because the bound is a safety net, not the expected duration. When
 * it does fire, the read degrades to its empty-or-zero fallback and the section
 * labels itself `unavailable`, so the rest of the page still renders.
 */
export const DASHBOARD_READ_TIMEOUT_MS = 8_000;

/**
 * The browser-side budget for one Dashboard request — the last line of defence.
 *
 * It is deliberately longer than the server's whole worst case (the parallel
 * batch plus the one dependent read, each bounded by `DASHBOARD_READ_TIMEOUT_MS`),
 * so the server's own honest degradation is what the reader sees when
 * persistence is merely slow. It exists for the case where the server never
 * answers at all: without it, a pending response would leave the panel on its
 * reading state forever. When it fires, the request reports itself as an error
 * the reader can retry, never as a silent hang.
 */
export const DASHBOARD_FETCH_TIMEOUT_MS = 20_000;

