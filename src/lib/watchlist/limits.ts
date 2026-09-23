/**
 * Server-enforced bounds for Watchlist V1 (docs/ARCHITECTURE.md §16.3).
 *
 * Monitoring is manual and bounded: every list read is capped, every
 * re-evaluation is a deliberate action, and no client request can exceed these
 * numbers. As with the scanner, values shipped to the browser are for display
 * only and are re-validated on arrival.
 *
 * Worst-case upstream budget for a batch re-evaluation, derived from these
 * numbers (docs/API_INTEGRATIONS.md §3, §4):
 *
 * ```text
 *   per entry   1 eBay search (reused as competition evidence)
 *           +  ≤ 3 CJ searches (matcher maxQueries)
 *           +   1 CJ variant query
 *           +   1–2 CJ freight calculations
 *           = ≤ 6 CJ calls
 *   max batch   6 entries  ⇒  ≤ 6 eBay + ≤ 36 CJ calls, in ≤ 3 concurrency waves
 * ```
 *
 * There is deliberately **no "re-evaluate all"**: the batch cap exists to bound
 * cost and wall-clock, and it is never raised by a query parameter.
 */

/**
 * Hard cap on active watchlist entries. Keeps every read bounded and makes the
 * page's worst case predictable; an entry is archived, never bulk-deleted.
 */
export const WATCHLIST_MAX_ENTRIES = 100;

/** Entries returned when the caller names no page size. */
export const WATCHLIST_DEFAULT_LIMIT = 20;

/** Hard ceiling on one list read. */
export const WATCHLIST_MAX_LIMIT = 50;

/** Timeline entries returned for one entry's history view. */
export const WATCHLIST_HISTORY_LIMIT = 12;

/**
 * Hard cap on how many entries one batch re-evaluation may process. Conservative
 * relative to the scanner's evaluation cap because a re-evaluation replays a
 * search per entry.
 */
export const WATCHLIST_MAX_RE_EVALUATIONS = 6;

/**
 * Concurrency for a bounded batch re-evaluation. Deliberately lower than the
 * scanner's: re-evaluations are user-driven refreshes, not a discovery sweep.
 */
export const WATCHLIST_CONCURRENCY = 2;

/** Wall-clock budget for one whole batch re-evaluation, in milliseconds. */
export const WATCHLIST_DEADLINE_MS = 120_000;

/**
 * Page size used to re-resolve a watched listing — identical to the scanner's
 * discovery limit and the opportunity route's resolve limit, so the replayed
 * window is the same shape the listing was found in (eBay reorders results
 * across page sizes — docs/ARCHITECTURE.md §8.3).
 */
export const WATCHLIST_RESOLVE_LIMIT = 24;

/** Matcher bounds, mirroring the opportunity route's so a re-evaluation scores the same candidate set the same way. */
export const WATCHLIST_MATCH_MAX_RESULTS = 10;

/**
 * History the engine is allowed to see per re-evaluation, identical to the
 * opportunity route's and the scanner's so all three paths read the same context.
 */
export const WATCHLIST_HISTORY_LIMITS = {
  maxPriorAssessments: 3,
  maxPriceObservations: 10,
  maxCompetitionSample: 20,
} as const;

/**
 * Bounds a requested watchlist page size to the documented ceiling and a sane
 * floor, falling back to the default for anything unusable.
 *
 * Pure on purpose: the bound is a contract worth unit-testing without any
 * database or credentials, and it is enforced again server-side at the route.
 */
export function clampWatchlistLimit(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return WATCHLIST_DEFAULT_LIMIT;
  }
  const bounded = Math.trunc(requested);
  return Math.min(Math.max(bounded, 1), WATCHLIST_MAX_LIMIT);
}
