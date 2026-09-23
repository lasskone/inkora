/**
 * Manual re-evaluation orchestration (docs/ARCHITECTURE.md §16.4).
 *
 * One user action becomes the *same trusted pipeline* a single assessment uses —
 * nothing is re-implemented and nothing is trusted from the browser:
 *
 * ```text
 *   watchlist stable identity
 *     → fresh eBay re-resolution (replaying the saved query)
 *     → bounded CJ matcher re-run, proving the saved supplier is still a candidate
 *     → fresh economics
 *     → Opportunity Engine assessment
 *     → existing persistence (append-only)
 *     → previous-vs-current comparison
 * ```
 *
 * Three contracts are load-bearing here:
 *
 *   1. **No stale browser economics.** The browser sends only the entry id; every
 *      price, cost, score and confidence is re-derived server-side.
 *   2. **Candidate re-proof, never substitution.** A saved supplier that no
 *      longer appears among the matcher's candidates yields an explicit
 *      `candidate-not-resolved` outcome. A different supplier product is never
 *      silently swapped in and presented as the same watched opportunity
 *      (docs/API_INTEGRATIONS.md §4).
 *   3. **The prior is read before the new assessment is persisted**, so a fresh
 *      assessment never compares against itself.
 *
 * Failure isolation is total: every outcome — including `listing-unavailable`,
 * `candidate-not-resolved`, `upstream-error` and `timeout` — leaves the entry and
 * every observation row untouched, so the last-known data stays on screen beside
 * the reason (docs/ARCHITECTURE.md §16.7).
 */

import "server-only";

import { mapCjError, mapEbayError } from "@/lib/products/upstream-errors";
import {
  resolveMarketplaceProduct,
  selectBestCandidate,
  selectCandidate,
  type CandidateResolutionPorts,
} from "@/lib/products/candidate-resolution";
import { assessOpportunity } from "@/lib/opportunity/assess";
import type { CompetitionEvidence } from "@/lib/opportunity/types";
import type { MatchCandidate, MatchResult } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { PersistedRecords } from "@/lib/persistence/persistence-service";

import { compareAssessments } from "./compare";
import {
  WATCHLIST_CONCURRENCY,
  WATCHLIST_DEADLINE_MS,
  WATCHLIST_HISTORY_LIMITS,
  WATCHLIST_MAX_RE_EVALUATIONS,
  WATCHLIST_RESOLVE_LIMIT,
} from "./limits";
import type {
  AssessmentComparison,
  PreviousObservation,
  ReEvaluationBatchResult,
  ReEvaluationOutcome,
  ReEvaluationResult,
  WatchlistPorts,
} from "./types";
import type { ScanDestination } from "@/lib/scanner/types";

/** The verdict outcomes — those that produced a fresh assessment. */
const VERDICT_OUTCOMES: ReadonlySet<ReEvaluationOutcome> = new Set([
  "evaluated",
  "no-candidates",
  "economics-unavailable",
]);

/**
 * Re-evaluates one watched opportunity.
 *
 * Never throws: every failure becomes an explicit outcome with a safe message,
 * so a batch never loses its remaining entries to one bad listing.
 */
export async function reevaluateEntry(params: {
  ports: WatchlistPorts;
  entryId: string;
  destination: ScanDestination;
  /** ISO 8601 UTC — injected by the route so a result is reproducible in tests. */
  now: string;
}): Promise<ReEvaluationResult> {
  const started = Date.now();
  const { ports, entryId, destination, now } = params;

  const base: ReEvaluationResult = {
    entryId,
    outcome: "upstream-error",
    assessment: null,
    comparison: null,
    evaluatedAt: now,
    durationMs: 0,
  };

  const entry = await ports.readEntry(entryId);
  if (entry === null) {
    return { ...base, outcome: "entry-not-found", durationMs: Date.now() - started };
  }
  if (entry.archivedAt !== null) {
    return { ...base, outcome: "archived", durationMs: Date.now() - started };
  }

  // The prior observation is read *before* anything upstream runs and long
  // before the new assessment is persisted, so a fresh assessment can never
  // count itself as its own prior. A read failure is reported as "no comparison"
  // (`comparison: null`) — distinct from a genuine first evaluation, which is
  // reported as `noPrevious: true`.
  let previous: PreviousObservation | null = null;
  let previousReadFailed = false;
  try {
    previous = await ports.readPreviousObservation({
      marketplaceExternalId: entry.marketplaceExternalId,
      supplierExternalId: entry.supplierExternalId,
    });
  } catch {
    previousReadFailed = true;
  }

  // --- Re-resolve the listing against a freshly replayed search window --------
  const resolutionPorts: CandidateResolutionPorts = {
    searchMarketplace: (request) => ports.searchMarketplace(request),
    matchCandidates: (product) => ports.matchCandidates(product),
  };

  const resolution = await resolveMarketplaceProduct({
    ports: resolutionPorts,
    itemId: entry.marketplaceExternalId,
    query: entry.replayQuery,
    resolveLimit: WATCHLIST_RESOLVE_LIMIT,
  });

  if (resolution.status === "item-not-found") {
    return {
      ...base,
      outcome: "listing-unavailable",
      failureCode: "ITEM_NOT_RESOLVED",
      failureMessage:
        "The eBay listing is no longer inside the replayed search window. It may have ended, sold out, or rotated out of this query's results.",
      durationMs: Date.now() - started,
    };
  }

  if (resolution.status === "marketplace-error") {
    const mapped = mapEbayError(resolution.error);
    return {
      ...base,
      outcome: "upstream-error",
      failureCode: mapped.code,
      failureMessage: mapped.message,
      durationMs: Date.now() - started,
    };
  }

  const marketplaceProduct = resolution.product;
  const searchResult = resolution.searchResult;


  // --- Re-prove the supplier candidate, never substitute a different one ------
  // The saved supplier external id must appear among the matcher's own
  // candidates for this listing; otherwise the opportunity this entry watches no
  // longer exists as saved, and that is reported — not papered over with the
  // matcher's current best guess (docs/ARCHITECTURE.md §16.4).
  let candidate: MatchCandidate | null = null;
  let matchResult: MatchResult;

  if (entry.supplierExternalId !== null) {
    const selection = await selectCandidate({
      ports: resolutionPorts,
      marketplaceProduct,
      supplierProductId: entry.supplierExternalId,
    });

    if (selection.status === "not-a-candidate" || selection.status === "no-candidates") {
      return {
        ...base,
        outcome: "candidate-not-resolved",
        failureCode: "CANDIDATE_NOT_FOUND",
        failureMessage:
          selection.status === "no-candidates"
            ? "The matcher surfaced no supplier candidate for this listing, so the saved supplier product could not be re-proven."
            : "The saved supplier product is no longer a matcher candidate for this listing. It has not been substituted with another supplier.",
        durationMs: Date.now() - started,
      };
    }

    if (selection.status === "supplier-error") {
      const mapped = mapCjError(selection.error);
      return {
        ...base,
        outcome: "upstream-error",
        ...(mapped
          ? { failureCode: mapped.code, failureMessage: mapped.message }
          : {
              failureCode: "INTERNAL_ERROR",
              failureMessage: "The supplier search could not be completed. Try again.",
            }),
        durationMs: Date.now() - started,
      };
    }

    candidate = selection.candidate;
    matchResult = selection.matchResult;
  } else {
    // A marketplace-only watch takes the matcher's current best candidate; none
    // is still an assessable state, hard-capped LOW by the engine.
    const selection = await selectBestCandidate(resolutionPorts, marketplaceProduct);
    if (selection.status === "supplier-error") {
      const mapped = mapCjError(selection.error);
      return {
        ...base,
        outcome: "upstream-error",
        ...(mapped
          ? { failureCode: mapped.code, failureMessage: mapped.message }
          : {
              failureCode: "INTERNAL_ERROR",
              failureMessage: "The supplier search could not be completed. Try again.",
            }),
        durationMs: Date.now() - started,
      };
    }
    candidate = selection.status === "selected" ? selection.candidate : null;
    matchResult = selection.matchResult;
  }

  // --- Fresh economics for the proven candidate ------------------------------
  let economics: EconomicsResult | null = null;
  let evaluation: PersistedRecords | null = null;

  if (candidate !== null) {
    try {
      const outcome = await ports.computeEconomics({ candidate, destination });
      economics = outcome.result;
      evaluation = await ports.persistEvaluation({
        marketplaceProduct,
        candidate,
        economics: outcome.result,
        selectedVariant: outcome.selectedVariant,
      });
    } catch (error) {
      const mapped = mapCjError(error);
      return {
        ...base,
        outcome: "upstream-error",
        ...(mapped
          ? { failureCode: mapped.code, failureMessage: mapped.message }
          : {
              failureCode: "INTERNAL_ERROR",
              failureMessage: "Economics could not be computed for this opportunity.",
            }),
        durationMs: Date.now() - started,
      };
    }
  }

  // --- The bounded history the engine is allowed to see ---------------------
  const history = await ports.readEvidence({
    marketplace: marketplaceProduct.marketplace,
    marketplaceExternalId: marketplaceProduct.externalId,
    supplierExternalId: candidate?.supplierProduct.externalId ?? null,
    limits: WATCHLIST_HISTORY_LIMITS,
  });

  // --- Assess: the replayed window *is* the competition evidence -------------
  const competition: CompetitionEvidence = {
    query: searchResult.query,
    searchResult,
  };

  const assessment = assessOpportunity({
    marketplaceProduct,
    candidate,
    economics,
    supplierQueries: matchResult.queries.map((query) => query.query),
    supplierCandidateCount: matchResult.candidates.length,
    competition,
    history,
    now,
    limits: WATCHLIST_HISTORY_LIMITS,
  });

  // --- Persist the assessment as history (best-effort, always reported) ------
  const persistence = await ports.persistAssessment({
    assessment,
    marketplaceProduct,
    evaluation,
  });

  // --- Compare with the immediately previous observation ---------------------
  const comparison: AssessmentComparison | null = previousReadFailed
    ? null
    : compareAssessments(previous, { assessment, economics });

  const outcome: ReEvaluationOutcome =
    candidate === null
      ? "no-candidates"
      : economics === null || assessment.components.economics.completeness === "UNAVAILABLE"
        ? "economics-unavailable"
        : "evaluated";

  return {
    ...base,
    outcome,
    assessment,
    comparison,
    persistence,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Bounded batch re-evaluation
// ---------------------------------------------------------------------------

/**
 * Re-evaluates a bounded set of watchlist entries, isolating every failure.
 *
 * There is deliberately **no "re-evaluate all"**: the caller's ids are clamped to
 * `WATCHLIST_MAX_RE_EVALUATIONS` by the route, the concurrency is a fixed
 * constant, and a whole-batch wall-clock budget bounds the work. One entry's
 * failure never forfeits the rest, exactly as a scan isolates its items
 * (docs/ARCHITECTURE.md §15.3, §16.4).
 */
export async function reevaluateBatch(params: {
  ports: WatchlistPorts;
  entryIds: string[];
  destination: ScanDestination;
  /** ISO 8601 UTC — injected by the route. */
  now: string;
}): Promise<ReEvaluationBatchResult> {
  const started = Date.now();
  const { ports, destination, now } = params;

  // De-duplicate while preserving order, then cap defensively: the route is the
  // authoritative bound, but the orchestrator never trusts its own caller.
  const uniqueIds: string[] = [];
  for (const id of params.entryIds) {
    if (!uniqueIds.includes(id)) {
      uniqueIds.push(id);
    }
  }
  const boundedIds = uniqueIds.slice(0, WATCHLIST_MAX_RE_EVALUATIONS);

  const deadlineRemaining = () => WATCHLIST_DEADLINE_MS - (Date.now() - started);

  const results = await mapWithConcurrency(
    boundedIds,
    WATCHLIST_CONCURRENCY,
    async (entryId: string): Promise<ReEvaluationResult> => {
      const remaining = deadlineRemaining();
      if (remaining <= 0) {
        return {
          entryId,
          outcome: "timeout",
          failureCode: "DEADLINE_REACHED",
          failureMessage:
            "The batch's time budget elapsed before this entry was re-evaluated.",
          assessment: null,
          comparison: null,
          evaluatedAt: now,
          durationMs: 0,
        };
      }

      try {
        return await withTimeout(reevaluateEntry({ ports, entryId, destination, now }), remaining);
      } catch (error) {
        if (error instanceof TimeoutMarker) {
          return {
            entryId,
            outcome: "timeout",
            failureCode: "DEADLINE_REACHED",
            failureMessage:
              "The batch's time budget elapsed while this entry was being re-evaluated.",
            assessment: null,
            comparison: null,
            evaluatedAt: now,
            durationMs: 0,
          };
        }
        // `reevaluateEntry` never throws, so this is genuinely unexpected.
        return {
          entryId,
          outcome: "upstream-error",
          failureCode: "INTERNAL_ERROR",
          failureMessage: "This entry could not be re-evaluated. Try it again.",
          assessment: null,
          comparison: null,
          evaluatedAt: now,
          durationMs: 0,
        };
      }
    },
  );

  const status: ReEvaluationBatchResult["status"] = results.every((result) =>
    VERDICT_OUTCOMES.has(result.outcome),
  )
    ? "ok"
    : "partial";

  return {
    status,
    results,
    limits: {
      maxReEvaluations: WATCHLIST_MAX_RE_EVALUATIONS,
      concurrency: WATCHLIST_CONCURRENCY,
      deadlineMs: WATCHLIST_DEADLINE_MS,
    },
    durationMs: Date.now() - started,
  };
}

/**
 * Sentinel thrown by `withTimeout` so the caller can tell "the budget ran out"
 * apart from "a provider failed". Private on purpose: it is an orchestration
 * detail, never something a caller reports verbatim.
 */
class TimeoutMarker extends Error {
  constructor() {
    super("The batch's time budget elapsed.");
    this.name = "TimeoutMarker";
  }
}

/**
 * Resolves with `promise`'s value, or rejects with a `TimeoutMarker` once
 * `budgetMs` has passed — the hard per-entry bound of a batch re-evaluation.
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
 * (`WATCHLIST_CONCURRENCY`), there is no queue, no retry and no backpressure —
 * the point is that a batch's upstream load stays small, fixed and reproducible.
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
