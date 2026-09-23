/**
 * Opportunity Scanner V1 — the bounded orchestration entry point
 * (docs/ARCHITECTURE.md §15).
 *
 * One user action becomes a predictable, auditable pipeline:
 *
 * ```text
 *   eBay search (1 call, limit 24)
 *     → select a bounded batch (≤ 6)
 *       → per item, at bounded concurrency (3):
 *           Product Matcher → Economics Engine → history → Opportunity Engine
 *         → persist the assessment (best-effort)
 *     → rank the verdicts deterministically
 *     → report every failure, item by item
 * ```
 *
 * The scanner **never duplicates domain logic**. Matching, money, and scoring
 * stay owned by the Product Matcher, the Economics Engine, and the Opportunity
 * Engine respectively; the scanner contributes the batch, the isolation, and the
 * order — nothing else. It also invents no score of its own: the ranking is the
 * Opportunity Engine's score plus documented tie-breakers (./ranking.ts).
 *
 * Failure isolation is the design constraint that shapes this module
 * (docs/ARCHITECTURE.md §15.3). A scan spans several listings and several
 * upstream round-trips, so a single bad listing must never forfeit the rest:
 *
 *   - a listing the matcher cannot source is a *verdict* (hard-capped LOW), not
 *     an error;
 *   - a listing whose economics cannot be quoted is a verdict with an explicit
 *     UNAVAILABLE economics component;
 *   - a listing whose id scrolled out of the replayed window, that timed out, or
 *     that hit an upstream failure is reported per item;
 *   - only the loss of the discovery window itself — or an unusable request —
 *     fails the whole scan.
 *
 * Persistence is best-effort and never turns a verdict into a failure: a storage
 * problem is reported on the item's `persistence` report, and the assessment is
 * still returned and still ranked (docs/ARCHITECTURE.md §13).
 */

import "server-only";

import { mapCjError } from "@/lib/products/upstream-errors";
import { assessOpportunity } from "@/lib/opportunity/assess";
import type { CompetitionEvidence } from "@/lib/opportunity/types";
import type {
  MarketplaceProduct,
  MarketplaceSearchResult,
} from "@/lib/marketplace/types";
import type { MatchCandidate, MatchResult } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { PersistedRecords } from "@/lib/persistence/persistence-service";

import {
  SCANNER_CONCURRENCY,
  SCANNER_DEADLINE_MS,
  SCANNER_DISCOVERY_LIMIT,
  SCANNER_HISTORY_LIMITS,
  SCANNER_MAX_EVALUATIONS,
  SCANNER_VERSION,
} from "./limits";
import { rankResults } from "./ranking";
import type {
  ScanDestination,
  ScanItem,
  ScanItemOutcome,
  ScanLimits,
  ScanMeta,
  ScanMode,
  ScanRequest,
  ScanResult,
  ScannerPorts,
} from "./types";
import { isVerdict } from "./types";

/**
 * Whole-pipeline failures: the scan could not produce anything, and the reason
 * is safe to report to a browser. Thrown deliberately — the route owns HTTP
 * translation, exactly as it does for the opportunity route's failures.
 */
export class ScanPipelineError extends Error {
  readonly code: ScanPipelineErrorCode;
  override readonly cause?: unknown;

  constructor(code: ScanPipelineErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ScanPipelineError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export type ScanPipelineErrorCode =
  | "INVALID_QUERY"
  | "INVALID_MODE"
  | "ITEMS_REQUIRED"
  | "INVALID_ITEM_ID"
  | "TOO_MANY_ITEMS"
  | "ITEM_NOT_RESOLVED"
  | "INVALID_DESTINATION"
  | "DISCOVERY_FAILED";

const MIN_QUERY_LENGTH = 1;
const MAX_QUERY_LENGTH = 100;
const ITEM_ID_PATTERN = /^[A-Za-z0-9|._-]{1,60}$/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * Runs one bounded scan. Never resolves to a partial structure: either a full
 * `ScanResult` (including its honest per-item failures) or a `ScanPipelineError`
 * for a request that could not begin at all.
 *
 * `now` is injected rather than read from the clock so a scan's timestamps — and
 * therefore every freshness rule downstream — stay reproducible in tests.
 */
export async function runOpportunityScan(args: {
  request: ScanRequest;
  ports: ScannerPorts;
  destination: ScanDestination;
  /** ISO 8601 UTC anchor; defaults to the current time in production. */
  now?: string;
}): Promise<ScanResult> {
  const startedAt = args.now ?? new Date().toISOString();
  const startedMs = Date.now();
  const query = validateQuery(args.request.query);
  const mode = validateMode(args.request.mode);
  const destination = validateDestination(args.destination);

  const limits: ScanLimits = {
    discoveryLimit: SCANNER_DISCOVERY_LIMIT,
    maxEvaluations: SCANNER_MAX_EVALUATIONS,
    concurrency: SCANNER_CONCURRENCY,
    deadlineMs: SCANNER_DEADLINE_MS,
  };

  // --- Discovery -----------------------------------------------------------
  // One eBay call. This window is reused verbatim as every item's competition
  // evidence, so competition costs zero additional eBay calls per item
  // (docs/API_INTEGRATIONS.md §3).
  let discovery: MarketplaceSearchResult;
  try {
    discovery = await args.ports.searchMarketplace({
      query,
      limit: SCANNER_DISCOVERY_LIMIT,
      offset: 0,
    });
  } catch (error) {
    // Nothing can be assessed without the window the user is looking at.
    throw new ScanPipelineError(
      "DISCOVERY_FAILED",
      "The marketplace search backing this scan could not be completed.",
      error,
    );
  }

  // --- Selection -----------------------------------------------------------
  // The browser never chooses *which* product object is assessed — it can only
  // ask the server to re-resolve ids inside the server's own window.
  const selection = selectBatch({
    mode,
    request: args.request,
    discovery,
  });

  const deadline = startedMs + SCANNER_DEADLINE_MS;

  // --- Deep evaluation, at bounded concurrency ------------------------------
  const evaluated = await mapWithConcurrency(
    selection.items,
    SCANNER_CONCURRENCY,
    async (product, index): Promise<ScanItem> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return timedOutItem(index, product);
      }
      return evaluateItem({
        product,
        discoveryIndex: index,
        ports: args.ports,
        query,
        searchResult: selection.searchResult,
        destination,
        remainingMs: remaining,
        now: startedAt,
      });
    },
  );

  // Ids the browser asked for that are no longer in the replayed window: the
  // scan reports each one honestly instead of silently dropping it.
  const unresolved: ScanItem[] = selection.unresolvedIds.map((itemId) => ({
    discoveryIndex: -1,
    marketplaceProduct: null,
    requestedItemId: itemId,
    matchResult: null,
    candidate: null,
    economics: null,
    assessment: null,
    history: null,
    outcome: "item-not-found",
    failureCode: "ITEM_NOT_RESOLVED",
    failureMessage:
      "This listing is no longer in the current search results, so it could not be assessed.",
    durationMs: 0,
  }));

  const all = [...evaluated, ...unresolved];
  const results = rankResults(all.filter((item) => isVerdict(item.outcome)));
  const failures = all.filter((item) => !isVerdict(item.outcome));

  const completedAt = new Date().toISOString();
  const meta: ScanMeta = {
    scannerVersion: SCANNER_VERSION,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedMs,
    query,
    mode,
    discoveryCount: discovery.products.length,
    selectedCount: selection.items.length,
    evaluatedCount: results.length,
    failedCount: failures.length,
    destinationLabel: destination.label,
    limits,
  };

  return {
    status: failures.length === 0 ? "ok" : "partial",
    meta,
    results,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Rejects a query that cannot be searched before any upstream call is made. */
function validateQuery(query: string | undefined): string {
  const trimmed = (query ?? "").trim();
  if (trimmed.length < MIN_QUERY_LENGTH || trimmed.length > MAX_QUERY_LENGTH) {
    throw new ScanPipelineError(
      "INVALID_QUERY",
      `A search query of ${MIN_QUERY_LENGTH}–${MAX_QUERY_LENGTH} characters is required.`,
    );
  }
  return trimmed;
}

function validateMode(mode: ScanMode | undefined): ScanMode {
  if (mode !== "manual" && mode !== "batch") {
    throw new ScanPipelineError(
      "INVALID_MODE",
      'Scan mode must be either "manual" or "batch".',
    );
  }
  return mode;
}

/**
 * Accepts the baseline destination as-is, or an ISO 3166-1 alpha-2 override the
 * caller supplied. An unparseable override is rejected rather than silently
 * ignored, because economics to an unknown destination are meaningless.
 */
function validateDestination(destination: ScanDestination): ScanDestination {
  if (destination.countryCode.length !== 2 || !COUNTRY_CODE_PATTERN.test(destination.countryCode)) {
    throw new ScanPipelineError(
      "INVALID_DESTINATION",
      "The destination country code must be two letters (ISO 3166-1 alpha-2).",
    );
  }
  return destination;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

interface BatchSelection {
  /** Listings to deep-evaluate, in discovery order. */
  items: MarketplaceProduct[];
  /** The discovery window itself, reused as competition evidence. */
  searchResult: MarketplaceSearchResult;
  /**
   * Ids the browser asked for that scrolled out of the replayed window. The
   * caller reports each as a per-item failure rather than matching it blindly.
   */
  unresolvedIds: string[];
}

/**
 * Turns a request into the bounded batch the scan will deep-evaluate.
 *
 * `batch` mode is deterministic and entirely server-chosen: the first `limit`
 * listings of the discovery window, `limit` clamped to the evaluation cap. No
 * client input can pick which listings run, and none can exceed the cap.
 *
 * `manual` mode re-resolves each requested id **inside the server's own window**
 * and returns every id that is no longer there as an unresolved id, which the
 * caller reports per item rather than matching blindly or aborting the scan.
 * This is the same stability rule the candidate-resolution flow enforces
 * (docs/ARCHITECTURE.md §8.3): the browser identifies a listing it has seen;
 * the server decides what that listing is.
 */
function selectBatch(args: {
  mode: ScanMode;
  request: ScanRequest;
  discovery: MarketplaceSearchResult;
}): BatchSelection {
  if (args.mode === "batch") {
    const limit = clampEvaluationLimit(args.request.limit);
    return {
      items: args.discovery.products.slice(0, limit),
      searchResult: args.discovery,
      unresolvedIds: [],
    };
  }

  const requested = normalizeItemIds(args.request.itemIds);
  if (requested.length === 0) {
    throw new ScanPipelineError(
      "ITEMS_REQUIRED",
      "A manual scan needs at least one eBay item id selected from the results.",
    );
  }
  if (requested.length > SCANNER_MAX_EVALUATIONS) {
    throw new ScanPipelineError(
      "TOO_MANY_ITEMS",
      `A manual scan evaluates at most ${SCANNER_MAX_EVALUATIONS} listings; ${requested.length} were selected.`,
    );
  }

  // Preserve discovery order, not the order the browser posted, so identical
  // selections always deep-evaluate in the same sequence.
  const items: MarketplaceProduct[] = [];
  const unresolvedIds: string[] = [];
  for (const id of requested) {
    const found = args.discovery.products.find((product) => product.externalId === id);
    if (found !== undefined) {
      items.push(found);
    } else {
      unresolvedIds.push(id);
    }
  }
  if (items.length === 0) {
    throw new ScanPipelineError(
      "ITEM_NOT_RESOLVED",
      "None of the selected listings are still in the current search results. Re-run the search, then try again.",
    );
  }

  return { items, searchResult: args.discovery, unresolvedIds };
}

/**
 * Deduplicates and validates requested ids without trusting their shape further
 * than the existing candidate-resolution flow does: opaque strings compared for
 * equality, never interpolated into a URL or upstream query.
 */
function normalizeItemIds(itemIds: string[] | undefined): string[] {
  if (!Array.isArray(itemIds)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of itemIds) {
    const id = (raw ?? "").trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    if (!ITEM_ID_PATTERN.test(id)) {
      throw new ScanPipelineError(
        "INVALID_ITEM_ID",
        "One of the selected item ids is not a valid eBay item id.",
      );
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Clamps a client-supplied batch size to the server-enforced evaluation cap. */
function clampEvaluationLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return SCANNER_MAX_EVALUATIONS;
  }
  const floored = Math.floor(limit);
  return Math.min(SCANNER_MAX_EVALUATIONS, Math.max(1, floored));
}


// ---------------------------------------------------------------------------
// Per-item deep evaluation
// ---------------------------------------------------------------------------

/**
 * Deep-evaluates one listing: match → economics → history → assessment →
 * persistence. Every failure is contained here and converted into an honest
 * `ScanItem`; nothing this function calls may propagate an exception, so one bad
 * listing never forfeits the batch.
 *
 * `remainingMs` is the scan's leftover wall-clock budget; a step that cannot
 * finish inside it is reported as a timeout instead of running open-endedly.
 */
async function evaluateItem(args: {
  product: MarketplaceProduct;
  discoveryIndex: number;
  ports: ScannerPorts;
  query: string;
  searchResult: MarketplaceSearchResult;
  destination: ScanDestination;
  remainingMs: number;
  now: string;
}): Promise<ScanItem> {
  const started = Date.now();
  const base = {
    discoveryIndex: args.discoveryIndex,
    marketplaceProduct: args.product,
    matchResult: null as MatchResult | null,
    candidate: null as MatchCandidate | null,
    economics: null as EconomicsResult | null,
    assessment: null,
    history: null,
    durationMs: 0,
  };

  try {
    // --- Match --------------------------------------------------------------
    // The matcher isolates per-query supplier failures itself and records them,
    // so a listing nothing sources yields zero candidates — a verdict the engine
    // hard-caps at LOW — rather than a thrown error.
    const matchResult = await withTimeout(
      args.ports.matchCandidates(args.product),
      args.remainingMs,
    );
    const candidate = matchResult.candidates[0] ?? null;

    // --- Economics ----------------------------------------------------------
    let economics: EconomicsResult | null = null;
    let evaluation: PersistedRecords | null = null;
    let economicsFailure: { code: string; message: string } | null = null;

    if (candidate !== null) {
      try {
        const outcome = await withTimeout(
          args.ports.computeEconomics({ candidate, destination: args.destination }),
          args.remainingMs,
        );
        economics = outcome.result;

        // Persistence of the evaluation is best-effort: a failure is reported on
        // the item and never blocks the assessment (docs/ARCHITECTURE.md §13).
        evaluation = await args.ports.persistEvaluation({
          marketplaceProduct: args.product,
          candidate,
          economics: outcome.result,
          selectedVariant: outcome.selectedVariant,
        });
      } catch (error) {
        const mapped = mapCjError(error);
        if (mapped === null) {
          throw error;
        }
        // A quote that cannot be obtained is a per-item verdict, not a scan
        // failure: the engine assesses with `economics: null`.
        economicsFailure = { code: mapped.code, message: mapped.message };
      }
    }

    // --- History ------------------------------------------------------------
    // Read before the assessment is persisted, so a fresh assessment never
    // counts itself as its own prior (docs/ARCHITECTURE.md §9).
    const history = await args.ports.readEvidence({
      marketplace: args.product.marketplace,
      marketplaceExternalId: args.product.externalId,
      supplierExternalId: candidate?.supplierProduct.externalId ?? null,
      limits: SCANNER_HISTORY_LIMITS,
    });

    // --- Assess -------------------------------------------------------------
    // The replayed discovery window *is* the competition evidence — verbatim,
    // with no second eBay call (docs/API_INTEGRATIONS.md §3).
    const competition: CompetitionEvidence = {
      query: args.query,
      searchResult: args.searchResult,
    };

    const assessment = assessOpportunity({
      marketplaceProduct: args.product,
      candidate,
      economics,
      supplierQueries: matchResult.queries.map((outcome) => outcome.query),
      supplierCandidateCount: matchResult.candidates.length,
      competition,
      history,
      now: args.now,
      limits: SCANNER_HISTORY_LIMITS,
    });

    // --- Persist the assessment --------------------------------------------
    const persistence = await args.ports.persistAssessment({
      assessment,
      marketplaceProduct: args.product,
      evaluation,
    });

    const outcome: ScanItemOutcome =
      candidate === null
        ? "no-candidates"
        : economics === null
          ? "economics-unavailable"
          : "evaluated";

    return {
      ...base,
      matchResult,
      candidate,
      economics,
      assessment,
      history,
      outcome,
      ...(persistence ? { persistence } : {}),
      ...(economicsFailure
        ? {
            failureCode: economicsFailure.code,
            failureMessage: economicsFailure.message,
          }
        : {}),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof TimeoutMarker) {
      return {
        ...base,
        outcome: "timeout",
        failureCode: "SCAN_DEADLINE_REACHED",
        failureMessage:
          "The scan's time budget elapsed before this listing was evaluated.",
        durationMs: Date.now() - started,
      };
    }

    const mapped = mapCjError(error);
    return {
      ...base,
      outcome: "upstream-error",
      ...(mapped
        ? { failureCode: mapped.code, failureMessage: mapped.message }
        : {
            failureCode: "INTERNAL_ERROR",
            failureMessage: "This listing could not be evaluated. Try it again.",
          }),
      durationMs: Date.now() - started,
    };
  }
}

/** A listing that never got to run because the scan's budget had elapsed. */
function timedOutItem(
  discoveryIndex: number,
  product: MarketplaceProduct,
): ScanItem {
  return {
    discoveryIndex,
    marketplaceProduct: product,
    matchResult: null,
    candidate: null,
    economics: null,
    assessment: null,
    history: null,
    outcome: "timeout",
    failureCode: "SCAN_DEADLINE_REACHED",
    failureMessage:
      "The scan's time budget elapsed before this listing was evaluated.",
    durationMs: 0,
  };
}


// ---------------------------------------------------------------------------
// Bounded concurrency and the deadline
// ---------------------------------------------------------------------------

/**
 * Sentinel thrown by `withTimeout` so the caller can tell "the budget ran out"
 * apart from "the provider failed". Private on purpose: it is an orchestration
 * detail, never something a caller reports verbatim.
 */
class TimeoutMarker extends Error {
  constructor() {
    super("The scan's time budget elapsed.");
    this.name = "TimeoutMarker";
  }
}

/**
 * Resolves with `promise`'s value, or rejects with a `TimeoutMarker` once
 * `budgetMs` has passed — whichever happens first. This is the scanner's hard
 * per-step bound: no upstream call may run open-endedly, because a scan is a
 * bounded budget, not a best-effort crawl (docs/ARCHITECTURE.md §15.1).
 */
function withTimeout<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  if (budgetMs <= 0) {
    return Promise.reject(new TimeoutMarker());
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutMarker()), budgetMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Runs `transform` over `items` with at most `concurrency` in flight at once,
 * preserving input order in the output.
 *
 * Deliberately not a general-purpose pool: the concurrency is a fixed constant
 * (`SCANNER_CONCURRENCY`), there is no queue, no retry, and no backpressure —
 * the whole point is that a scan's upstream load is small, fixed, and
 * reproducible (docs/API_INTEGRATIONS.md §3.7).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  transform: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const effective = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      results[index] = await transform(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(effective, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

