/**
 * Server-enforced bounds for the Opportunity Scanner V1.
 *
 * The scanner is a *bounded* pipeline: one user action fans out into a
 * predictable, auditable number of upstream calls, and no client request can
 * exceed these numbers. Every limit here is enforced server-side — the values
 * shipped to the browser (`src/types/scanner.ts`) are for display only and are
 * re-validated on arrival (docs/ARCHITECTURE.md §15, docs/API_INTEGRATIONS.md
 * §3.7).
 *
 * Worst-case upstream budget per scan, derived from these numbers
 * (docs/API_INTEGRATIONS.md §3, §4):
 *
 * ```text
 *   discovery  1 eBay search  (limit 24)
 *   per item   ≤ 3 CJ searches (matcher maxQueries)
 *            +  1 CJ variant query
 *            +  1–2 CJ freight calculations
 *            = ≤ 6 CJ calls
 *   max batch  6 items  ⇒  1 eBay + ≤ 36 CJ calls, in ≤ 2 concurrency waves
 * ```
 *
 * The batch cap exists to bound that cost and the wall-clock budget; it is
 * deliberately far below the discovery limit so deep evaluation stays a
 * deliberate, bounded action rather than a bulk crawl.
 */

/**
 * Maximum eBay results surfaced for selection. Matches the search route's page
 * size and the resolve limit the candidate-resolution flow replays, so an id the
 * user selects stays inside the window the scanner replays
 * (docs/ARCHITECTURE.md §8.3).
 */
export const SCANNER_DISCOVERY_LIMIT = 24;

/**
 * Hard cap on how many listings one scan may deep-evaluate. Client requests are
 * clamped to this; it is never raised by a query parameter.
 */
export const SCANNER_MAX_EVALUATIONS = 6;

/**
 * Deterministic concurrency for deep evaluation. No queue, no Redis: a fixed
 * pool of workers over the selected batch, so a scan's upstream-call ordering
 * stays reproducible and the load on eBay/CJ stays small.
 */
export const SCANNER_CONCURRENCY = 3;

/**
 * Wall-clock budget for one whole scan, in milliseconds. A scan never exceeds
 * it: items still in flight past the deadline are reported as timed out and the
 * caller sees every result that did complete (docs/ARCHITECTURE.md §15).
 */
export const SCANNER_DEADLINE_MS = 90_000;

/**
 * Matcher bounds the scanner applies, mirroring the opportunity route's
 * (`OPPORTUNITY_MATCH_MAX_RESULTS`) so a scan and a single assessment score the
 * same candidate set the same way.
 */
export const SCANNER_MATCH_MAX_RESULTS = 10;

/**
 * History the engine is allowed to see per item, identical to the opportunity
 * route's `OPPORTUNITY_LIMITS` so a scan's assessment is directly comparable to
 * a single-item assessment.
 */
export const SCANNER_HISTORY_LIMITS = {
  maxPriorAssessments: 3,
  maxPriceObservations: 10,
  maxCompetitionSample: 20,
} as const;

/** Version of the scanner orchestration, carried in results for traceability. */
export const SCANNER_VERSION = "scanner-v1";
