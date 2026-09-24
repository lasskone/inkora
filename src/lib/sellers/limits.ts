/**
 * Server-enforced bounds for the Seller Scanner V1.
 *
 * The scanner is a *bounded* pipeline: one user action fans out into a
 * predictable, auditable number of upstream calls, and no client request can
 * exceed these numbers. Every limit here is enforced server-side — the values
 * shipped to the browser (`src/types/sellers.ts`) are for display only and are
 * re-validated on arrival, never trusted.
 *
 * Worst-case upstream budget for one scan, derived from these numbers:
 *
 * ```text
 *   seller sample   1 eBay search  (sampleLimit results)
 *   recent listings 1 eBay search  (recentLimit, sort = newest listed)
 *   overlap         ≤ overlapAnalyses eBay searches (one per analyzed family)
 *   deep evaluate   NOT automatic — user-triggered, and then it costs the
 *                   opportunity route's own bounded budget, not this one's
 *   persistence      1 seller identity upsert + 1 seller observation append +
 *                    ≤ sampleLimit listing observation appends (best effort)
 * ```
 *
 * So one scan costs **2 + ≤ overlapAnalyses** eBay calls, plus bounded database
 * writes. Cross-seller overlap is a deliberately small number: it is the only
 * component that grows the eBay call count, and deep Opportunity evaluation is
 * kept strictly user-triggered so a scan can never silently become a crawl.
 */

/**
 * Maximum listings one scan may return as the statistical sample. eBay's Browse
 * API caps a page at 200; this is far below it on purpose, because the sample
 * feeds price/category/concentration analysis and every sampled listing is also
 * a persistence write.
 */
export const SELLER_SAMPLE_MAX = 50;
/** Page size used when the client does not name one. */
export const SELLER_SAMPLE_DEFAULT = 24;

/**
 * Maximum listings in the "recently added" view. Backed by a dedicated
 * newest-listed search, so its ordering is the marketplace's own publication
 * order, not Inkora's inference.
 */
export const SELLER_RECENT_MAX = 20;
export const SELLER_RECENT_DEFAULT = 8;

/**
 * Ceiling on the marketplace result window read for one cross-seller overlap
 * analysis. The evidence is "who else lists this family", and a bounded window
 * answers that honestly without enumerating a whole result set.
 */
export const SELLER_OVERLAP_WINDOW_MAX = 100;
export const SELLER_OVERLAP_WINDOW_DEFAULT = 50;

/**
 * Hard cap on how many distinct product families one scan may run overlap
 * analysis for. Each costs one eBay search, so this is the scan's incremental
 * cost knob. It is never raised by a client request.
 */
export const SELLER_OVERLAP_ANALYSES_MAX = 5;
export const SELLER_OVERLAP_ANALYSES_DEFAULT = 3;

/** A seller identifier is short; this is a shape check, not a semantic one. */
export const SELLER_USERNAME_MAX_LENGTH = 64;

/** The search context that scopes a seller's enumerable listings. */
export const SELLER_QUERY_MAX_LENGTH = 100;
export const SELLER_QUERY_MIN_LENGTH = 1;

/**
 * eBay caps a result set at 10,000 and requires `offset` to be a multiple of
 * the page `limit`; the scanner snaps any client offset onto that grid rather
 * than letting an arbitrary value error out upstream.
 */
export const SELLER_MAX_OFFSET = 9_999;

/**
 * Bounded concurrency for the listing-observation pass, so a scan's database
 * write ordering stays small and reproducible. No queue, no Redis.
 */
export const SELLER_PERSISTENCE_CONCURRENCY = 4;

/** Wall-clock budget for one whole scan, in milliseconds. */
export const SELLER_SCAN_DEADLINE_MS = 60_000;

/** Version of the scanner orchestration, carried in results for traceability. */
export const SELLER_SCANNER_VERSION = "seller-scanner-v1";

/** Bounds a requested sample size to the documented ceiling and a sane floor. */
export function clampSampleLimit(requested: number | undefined): number {
  return clampBounded(requested, 1, SELLER_SAMPLE_MAX, SELLER_SAMPLE_DEFAULT);
}

/** Bounds the "recently added" page size. */
export function clampRecentLimit(requested: number | undefined): number {
  return clampBounded(requested, 1, SELLER_RECENT_MAX, SELLER_RECENT_DEFAULT);
}

/** Bounds one overlap analysis' marketplace window. */
export function clampOverlapWindow(requested: number | undefined): number {
  return clampBounded(
    requested,
    1,
    SELLER_OVERLAP_WINDOW_MAX,
    SELLER_OVERLAP_WINDOW_DEFAULT,
  );
}

/** Bounds the number of overlap analyses one scan may run. */
export function clampOverlapAnalyses(requested: number | undefined): number {
  return clampBounded(
    requested,
    0,
    SELLER_OVERLAP_ANALYSES_MAX,
    SELLER_OVERLAP_ANALYSES_DEFAULT,
  );
}

/**
 * Snaps a client offset onto the eBay pagination grid (a multiple of the page
 * limit) and bounds it to the documented maximum. A negative or unusable value
 * becomes the first page.
 */
export function snapOffset(
  requested: number | undefined,
  limit: number,
): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return 0;
  const truncated = Math.trunc(requested);
  if (truncated <= 0) return 0;
  const safeLimit = limit > 0 ? limit : SELLER_SAMPLE_DEFAULT;
  const snapped = Math.floor(truncated / safeLimit) * safeLimit;
  return Math.min(snapped, SELLER_MAX_OFFSET);
}

/**
 * Shared clamp: an unusable value falls back to the default, a usable one is
 * truncated and held between the floor and ceiling. Pure on purpose — the bound
 * is a contract worth unit-testing with no network or credentials.
 */
function clampBounded(
  requested: number | undefined,
  floor: number,
  ceiling: number,
  fallback: number,
): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return fallback;
  }
  const truncated = Math.trunc(requested);
  return Math.min(Math.max(truncated, floor), ceiling);
}
