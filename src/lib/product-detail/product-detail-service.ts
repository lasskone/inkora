/**
 * Product Detail service — server-only orchestration of the read model
 * (docs/ARCHITECTURE.md §18.6).
 *
 * Two operations, both persisted-first:
 *
 *   read      — assemble everything already stored for one listing. Zero eBay,
 *               zero CJ, zero freight, zero scoring. A normal page load costs no
 *               upstream call at all, and one failing table costs only its own
 *               section (§18.5).
 *
 *   refresh   — a *deliberate* re-evaluation the user asks for explicitly. It
 *               replays the search window that surfaced the listing and re-proves
 *               the persisted pairing through the matcher's own candidates,
 *               using the Watchlist's ports verbatim — the same engines, in the
 *               same order, with the same upstream budget, so no intelligence is
 *               duplicated and the two paths cannot drift (docs/ARCHITECTURE.md
 *               §16.4). A supplier that is no longer a matcher candidate is
 *               reported, never substituted (§18.4).
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { mapCjError, mapEbayError } from "@/lib/products/upstream-errors";
import {
  resolveMarketplaceProduct,
  selectBestCandidate,
  selectCandidate,
  type CandidateResolutionPorts,
} from "@/lib/products/candidate-resolution";
import { assessOpportunity } from "@/lib/opportunity/assess";
import type {
  CompetitionEvidence,
  OpportunityAssessment,
  OpportunityLimits,
} from "@/lib/opportunity/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { MatchCandidate, MatchResult } from "@/lib/matcher/types";
import type { ScanDestination } from "@/lib/scanner/types";
import { createPersistenceClient } from "@/lib/persistence/client";
import type { PersistedRecords } from "@/lib/persistence/persistence-service";
import { compareAssessments } from "@/lib/watchlist/compare";
import { createWatchlistService } from "@/lib/watchlist/watchlist-ports";
import { WATCHLIST_HISTORY_LIMITS, WATCHLIST_RESOLVE_LIMIT } from "@/lib/watchlist/limits";
import type {
  AssessmentComparison,
  PreviousObservation,
  WatchlistPorts,
} from "@/lib/watchlist/types";
import type { ProductDetailRefreshOutcome } from "@/types/product-detail";
import type { OpportunityPersistenceReport } from "@/types/opportunity";

import {
  buildProductDetail,
  type ProductDetailReads,
  type SupplierSnapshotRead,
} from "./read-model";
import {
  findMarketplaceProductId,
  findSupplierProductId,
  readAssessmentHistory,
  readEconomicsSummary,
  readLatestEconomics,
  readMarketplaceSnapshots,
  readMatchObservations,
  readReplayQuery,
  readSupplierProducts,
  type ProductScope,
} from "./product-detail-repository";
import type { ProductDetail } from "./types";

/**
 * History reads are bounded everywhere they appear. 25 is generous next to the
 * watchlist timeline's 12 because this page's history series is its point; it is
 * still a hard bound, so the page's worst case stays predictable.
 */
export const PRODUCT_DETAIL_HISTORY_LIMIT = 25;

/**
 * History the refresh's assessment is allowed to see — identical to the
 * watchlist's and the scanner's, so all three paths score the same context
 * (docs/ARCHITECTURE.md §16.3).
 */
export const PRODUCT_DETAIL_HISTORY_LIMITS: OpportunityLimits = WATCHLIST_HISTORY_LIMITS;

export interface ProductDetailReadOptions {
  /** Persistence client; created when omitted. `null` means persistence is off. */
  persistence?: SupabaseClient | null;
  /** Bounded history window; defaults to {@link PRODUCT_DETAIL_HISTORY_LIMIT}. */
  historyLimit?: number;
  /** ISO 8601 UTC. Injected so tests are deterministic. */
  now?: string;
}

/**
 * Result of a persisted read — every field present so the route can render the
 * honest state that matches it.
 */
export type ProductDetailReadResult =
  | { status: "ok"; detail: ProductDetail }
  | { status: "not-observed" }
  | { status: "disabled" };

/**
 * Assembles the read model for one marketplace listing.
 *
 * Performs no upstream call. Reads are bounded and each is wrapped so a failed
 * table degrades that section to `unavailable` rather than failing the page.
 */
export async function readProductDetail(params: {
  itemId: string;
  query: string;
  supplierProductId: string | null;
  options?: ProductDetailReadOptions;
}): Promise<ProductDetailReadResult> {
  const persistence = params.options?.persistence ?? createPersistenceClient();
  if (persistence === null) {
    return { status: "disabled" };
  }

  const client = persistence;
  const now = params.options?.now ?? new Date().toISOString();
  const limit = params.options?.historyLimit ?? PRODUCT_DETAIL_HISTORY_LIMIT;

  const marketplaceProductId = await safe(
    findMarketplaceProductId(client, params.itemId),
    null,
  );
  if (marketplaceProductId === null) {
    return { status: "not-observed" };
  }

  const supplierProductId =
    params.supplierProductId === null
      ? null
      : await safe(findSupplierProductId(client, params.supplierProductId), null);

  const scope: ProductScope = { marketplaceProductId, supplierProductId };

  const replayQuery = await safe(readReplayQuery(client, marketplaceProductId), null);
  const assessments = await safe(readAssessmentHistory(client, scope, limit), []);
  const marketplaceSnapshots = await safe(
    readMarketplaceSnapshots(client, marketplaceProductId, limit),
    [],
  );
  const matchObservations = await safe(readMatchObservations(client, scope, limit), []);
  const economicsObservations = await safe(readEconomicsSummary(client, scope, limit), []);
  const latestEconomics = await safe(readLatestEconomics(client, scope), null);
  const supplierSnapshots: SupplierSnapshotRead[] =
    supplierProductId === null
      ? []
      : await safe(readSupplierProducts(client, supplierProductId), []);
  const watchlistState = await safe(
    readWatchlistState(client, scope),
    { entryId: null, archived: false },
  );

  const reads: ProductDetailReads = {
    now,
    marketplaceExternalId: params.itemId,
    replayQuery,
    supplierExternalId: params.supplierProductId,
    marketplaceSnapshots,
    matchObservations,
    economicsObservations,
    assessments,
    supplierSnapshots,
    latestEconomics,
    watched: watchlistState,
    historyLimit: limit,
  };

  return { status: "ok", detail: buildProductDetail(reads) };
}

/** The watchlist entry state for this scope, or `null` when unwatched. */
interface WatchlistScopeState {
  entryId: string | null;
  archived: boolean;
}

/**
 * Reads the watchlist state for one scope.
 *
 * Reuses the watchlist's own table and vocabulary so Product Detail never
 * duplicates monitoring persistence (docs/ARCHITECTURE.md §15). A NULL supplier
 * is a distinct scope — `is null` in the query, never a value.
 */
async function readWatchlistState(
  client: SupabaseClient,
  scope: ProductScope,
): Promise<WatchlistScopeState> {
  const query = client.from("watchlist_entries").select("id, archived");
  const scoped =
    scope.supplierProductId === null
      ? query
          .eq("marketplace_product_id", scope.marketplaceProductId)
          .is("supplier_product_id", null)
      : query
          .eq("marketplace_product_id", scope.marketplaceProductId)
          .eq("supplier_product_id", scope.supplierProductId);

  const { data, error } = await scoped.limit(1);
  if (error !== null || data === null || data.length === 0) {
    return { entryId: null, archived: false };
  }
  const row = data[0] as { id: string; archived: boolean | null };
  return { entryId: row.id, archived: row.archived === true };
}

/**
 * Swallows a failure into a fallback, so one unavailable table degrades its own
 * section instead of the page (docs/ARCHITECTURE.md §18.5).
 */
async function safe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}


// ---------------------------------------------------------------------------
// Deliberate refresh — same engines as a watchlist re-evaluation, then re-read
// ---------------------------------------------------------------------------

/**
 * One refresh result. The `failure*` fields are present only for non-verdict
 * outcomes; `detail` is present whenever storage still holds the scope, so the
 * page can render last-known data beside the reason and never lose what it had
 * (docs/ARCHITECTURE.md §16.7, §18.6).
 */
export type ProductDetailRefreshResult =
  | {
      outcome: "evaluated";
      assessment: OpportunityAssessment;
      comparison: AssessmentComparison | null;
      persistence: OpportunityPersistenceReport | undefined;
      detail: ProductDetail | null;
      durationMs: number;
    }
  | {
      outcome: Extract<ProductDetailRefreshOutcome, "no-candidates" | "economics-unavailable">;
      assessment: OpportunityAssessment;
      detail: ProductDetail | null;
      durationMs: number;
    }
  | {
      outcome: Extract<
        ProductDetailRefreshOutcome,
        "item-not-found" | "candidate-not-resolved" | "upstream-error"
      >;
      failureCode: string;
      failureMessage: string;
      detail: ProductDetail | null;
      durationMs: number;
    }
  | {
      /** Persistence is off, so nothing can be re-evaluated or re-read. */
      outcome: "disabled";
    };

export interface ProductDetailRefreshOptions {
  /** The watchlist service whose ports run the pipeline; created when omitted. */
  watchlist?: { ports: WatchlistPorts; client: SupabaseClient } | null;
  /** Persistence client for the read-back; created when omitted. */
  persistence?: SupabaseClient | null;
  /** ISO 8601 UTC. Injected so tests are deterministic. */
  now?: string;
}

/**
 * Re-evaluates one listing deliberately, then reads the scope back.
 *
 * This is never automatic and never silent. The request carries only ids and the
 * query — every price, cost, score and confidence is re-derived server-side.
 * The prior observation is read *before* anything upstream runs and long before
 * the new assessment is persisted, so a fresh assessment can never count itself
 * as its own prior. The persisted pairing is re-proved, never substituted, and
 * every failure leaves the stored rows untouched.
 */
export async function refreshProductDetail(params: {
  itemId: string;
  query: string;
  supplierProductId: string | null;
  destination: ScanDestination;
  options?: ProductDetailRefreshOptions;
}): Promise<ProductDetailRefreshResult> {
  const started = Date.now();
  const now = params.options?.now ?? new Date().toISOString();

  const watchlist = params.options?.watchlist ?? createWatchlistService();
  if (watchlist === null) {
    return { outcome: "disabled" };
  }

  const client = params.options?.persistence ?? watchlist.client;

  const resolutionPorts: CandidateResolutionPorts = {
    searchMarketplace: (request) => watchlist.ports.searchMarketplace(request),
    matchCandidates: (product) => watchlist.ports.matchCandidates(product),
  };

  // The prior is read before any upstream call, so the comparison below cannot
  // be against the assessment this refresh is about to write.
  let previous: PreviousObservation | null = null;
  let previousReadFailed = false;
  try {
    previous = await watchlist.ports.readPreviousObservation({
      marketplaceExternalId: params.itemId,
      supplierExternalId: params.supplierProductId,
    });
  } catch {
    previousReadFailed = true;
  }

  // The page always reflects storage, so every outcome below can carry the
  // last-known read model beside its own reason.
  const detail = await readBack(params, client, now);

  // --- Re-resolve the listing against a freshly replayed search window -------
  const resolution = await resolveMarketplaceProduct({
    ports: resolutionPorts,
    itemId: params.itemId,
    query: params.query,
    resolveLimit: WATCHLIST_RESOLVE_LIMIT,
  });

  if (resolution.status === "item-not-found") {
    return {
      outcome: "item-not-found",
      failureCode: "ITEM_NOT_RESOLVED",
      failureMessage:
        "The eBay listing is no longer inside the replayed search window. It may have ended, sold out, or rotated out of this query's results.",
      detail,
      durationMs: Date.now() - started,
    };
  }

  if (resolution.status === "marketplace-error") {
    return {
      outcome: "upstream-error",
      ...mappedFailure(mapEbayError(resolution.error)),
      detail,
      durationMs: Date.now() - started,
    };
  }

  const marketplaceProduct = resolution.product;
  const searchResult = resolution.searchResult;


  // --- Re-prove the supplier candidate, never substitute a different one ------
  let candidate: MatchCandidate | null = null;
  let matchResult: MatchResult;

  if (params.supplierProductId !== null) {
    const selection = await selectCandidate({
      ports: resolutionPorts,
      marketplaceProduct,
      supplierProductId: params.supplierProductId,
    });

    if (selection.status === "not-a-candidate" || selection.status === "no-candidates") {
      return {
        outcome: "candidate-not-resolved",
        failureCode: "CANDIDATE_NOT_FOUND",
        failureMessage:
          selection.status === "no-candidates"
            ? "The matcher surfaced no supplier candidate for this listing, so the saved supplier product could not be re-proven."
            : "The saved supplier product is no longer a matcher candidate for this listing. It has not been substituted with another supplier.",
        detail,
        durationMs: Date.now() - started,
      };
    }

    if (selection.status === "supplier-error") {
      return {
        outcome: "upstream-error",
        ...mappedFailure(mapCjError(selection.error)),
        detail,
        durationMs: Date.now() - started,
      };
    }

    candidate = selection.candidate;
    matchResult = selection.matchResult;
  } else {
    // A marketplace-only view takes the matcher's current best candidate; none
    // is still an assessable state, hard-capped LOW by the engine.
    const selection = await selectBestCandidate(resolutionPorts, marketplaceProduct);
    if (selection.status === "supplier-error") {
      return {
        outcome: "upstream-error",
        ...mappedFailure(mapCjError(selection.error)),
        detail,
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
      const outcome = await watchlist.ports.computeEconomics({
        candidate,
        destination: params.destination,
      });
      economics = outcome.result;
      evaluation = await watchlist.ports.persistEvaluation({
        marketplaceProduct,
        candidate,
        economics: outcome.result,
        selectedVariant: outcome.selectedVariant,
      });
    } catch (error) {
      return {
        outcome: "upstream-error",
        ...mappedFailure(mapCjError(error), "Economics could not be computed for this opportunity."),
        detail,
        durationMs: Date.now() - started,
      };
    }
  }

  // --- The bounded history the engine is allowed to see ----------------------
  const history = await watchlist.ports.readEvidence({
    marketplace: marketplaceProduct.marketplace,
    marketplaceExternalId: marketplaceProduct.externalId,
    supplierExternalId: candidate?.supplierProduct.externalId ?? null,
    limits: PRODUCT_DETAIL_HISTORY_LIMITS,
  });

  // --- Assess: the replayed window *is* the competition evidence --------------
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
    limits: PRODUCT_DETAIL_HISTORY_LIMITS,
  });

  // --- Persist the assessment as history (best-effort, always reported) -------
  const persistence = await watchlist.ports.persistAssessment({
    assessment,
    marketplaceProduct,
    evaluation,
  });

  // --- Compare with the immediately previous observation ----------------------
  const comparison: AssessmentComparison | null = previousReadFailed
    ? null
    : compareAssessments(previous, { assessment, economics });

  const outcome: Extract<ProductDetailRefreshOutcome, "evaluated" | "no-candidates" | "economics-unavailable"> =
    candidate === null
      ? "no-candidates"
      : economics === null || assessment.components.economics.completeness === "UNAVAILABLE"
        ? "economics-unavailable"
        : "evaluated";

  if (outcome === "evaluated") {
    return {
      outcome,
      assessment,
      comparison,
      persistence,
      detail,
      durationMs: Date.now() - started,
    };
  }

  return {
    outcome,
    assessment,
    detail,
    durationMs: Date.now() - started,
  };
}

/**
 * Reads the scope back after a refresh, so the page reflects storage rather than
 * an in-memory result the user cannot verify (docs/ARCHITECTURE.md §18.6).
 */
async function readBack(
  params: { itemId: string; query: string; supplierProductId: string | null },
  client: SupabaseClient,
  now: string,
): Promise<ProductDetail | null> {
  try {
    const result = await readProductDetail({
      itemId: params.itemId,
      query: params.query,
      supplierProductId: params.supplierProductId,
      options: { persistence: client, now },
    });
    return result.status === "ok" ? result.detail : null;
  } catch {
    return null;
  }
}

/**
 * Maps a mapped upstream failure onto the fields a non-verdict outcome carries.
 * A missing mapping is reported as internal rather than as a silent success.
 */
function mappedFailure(
  mapped: { code: string; message: string } | null,
  fallbackMessage = "The upstream provider could not be reached.",
): { failureCode: string; failureMessage: string } {
  return mapped === null
    ? { failureCode: "INTERNAL_ERROR", failureMessage: fallbackMessage }
    : { failureCode: mapped.code, failureMessage: mapped.message };
}

