/**
 * Shared candidate resolution for the product-intelligence API routes
 * (docs/ARCHITECTURE.md §8.3).
 *
 * Every product route that the browser addresses by `itemId` has to do the same
 * two things before any real work can start:
 *
 *   1. **Replay the search the user ran** and locate the listing in it, because
 *      the browser never posts a raw marketplace object — it identifies a
 *      listing it has already seen (docs/API_INTEGRATIONS.md §2.2).
 *   2. **Re-run the bounded matcher** to prove a supplier product really is a
 *      candidate for that listing, because a supplier id is never trusted on
 *      its own (docs/ARCHITECTURE.md §10).
 *
 * Doing that inline in each route duplicated the logic and, worse, hid the
 * upstream-call budget. This module does it once, with the marketplace and
 * supplier capabilities **injected as ports**, so:
 *
 *   - one route reuses another's bounded budget, and the budget is visible in
 *     one place;
 *   - the resolution flow is unit-testable with fakes and no network;
 *   - errors are returned, never thrown, so a route can map them to its own
 *     response vocabulary instead of catching around an opaque helper.
 *
 * The replayed search window is returned alongside the resolved listing because
 * the Opportunity Engine reuses it — verbatim — as its competition evidence,
 * which is how V1 spends zero additional eBay calls on competition
 * (docs/API_INTEGRATIONS.md §3).
 */

import "server-only";

import type {
  MarketplaceProduct,
  MarketplaceSearchRequest,
  MarketplaceSearchResult,
} from "@/lib/marketplace/types";
import type { MatchCandidate, MatchResult } from "@/lib/matcher/types";

/**
 * The external capabilities resolution needs, injected by the route.
 *
 * Constructing adapters inside this module would make the flow impossible to
 * test without a network and would hide how many upstream calls a single
 * request costs; injecting them makes both explicit.
 */
export interface CandidateResolutionPorts {
  /** Replays the marketplace search that surfaced the listing. */
  searchMarketplace(
    request: MarketplaceSearchRequest,
  ): Promise<MarketplaceSearchResult>;
  /** Runs the bounded matcher against the resolved listing. */
  matchCandidates(marketplaceProduct: MarketplaceProduct): Promise<MatchResult>;
}

/** Outcome of replaying the search window and locating the listing in it. */
export type MarketplaceResolutionResult =
  | {
      status: "ok";
      product: MarketplaceProduct;
      /** The replayed window itself, for reuse as competition evidence. */
      searchResult: MarketplaceSearchResult;
    }
  /** The id scrolled out of the window: reported, never matched blindly. */
  | { status: "item-not-found" }
  /** A provider failure; the route maps it to its own status and code. */
  | { status: "marketplace-error"; error: unknown };

/**
 * Replays the scanner's own search and locates the item id in that window.
 *
 * The page size is supplied by the caller because it must mirror what the
 * Product Scanner requested: eBay reorders results across page sizes, so a
 * different `limit` can legitimately fail to find an id the user clicked.
 */
export async function resolveMarketplaceProduct(params: {
  ports: CandidateResolutionPorts;
  itemId: string;
  query: string;
  /** Page size, chosen by the route to mirror the search the user ran. */
  resolveLimit: number;
}): Promise<MarketplaceResolutionResult> {
  try {
    const searchResult = await params.ports.searchMarketplace({
      query: params.query,
      limit: params.resolveLimit,
      offset: 0,
    });

    const product = searchResult.products.find(
      (candidate) => candidate.externalId === params.itemId,
    );
    if (product === undefined) {
      return { status: "item-not-found" };
    }

    return { status: "ok", product, searchResult };
  } catch (error) {
    return { status: "marketplace-error", error };
  }
}

/** Outcome of re-running the matcher and selecting one of its candidates. */
export type CandidateSelection =
  | { status: "selected"; matchResult: MatchResult; candidate: MatchCandidate }
  /** The requested supplier product is not a matcher candidate for this listing. */
  | { status: "not-a-candidate"; matchResult: MatchResult }
  /** The matcher surfaced no candidate at all — a legitimate, assessable state. */
  | { status: "no-candidates"; matchResult: MatchResult }
  | { status: "supplier-error"; error: unknown };

/**
 * Re-runs the bounded matcher and locates the requested supplier product among
 * its candidates.
 *
 * `supplierProductId` is required: this is the call that guarantees economics
 * are only ever produced for a genuine matcher candidate. A route that wants to
 * assess a listing *without* a chosen candidate should call
 * `selectBestCandidate` instead.
 */
export async function selectCandidate(params: {
  ports: CandidateResolutionPorts;
  marketplaceProduct: MarketplaceProduct;
  supplierProductId: string;
}): Promise<CandidateSelection> {
  const selection = await selectBestCandidate(params.ports, params.marketplaceProduct);
  if (selection.status !== "selected") {
    return selection;
  }

  if (selection.candidate.supplierProduct.externalId === params.supplierProductId) {
    return selection;
  }

  const named = selection.matchResult.candidates.find(
    (candidate) => candidate.supplierProduct.externalId === params.supplierProductId,
  );
  if (named === undefined) {
    return { status: "not-a-candidate", matchResult: selection.matchResult };
  }
  return { status: "selected", matchResult: selection.matchResult, candidate: named };
}

/**
 * Re-runs the bounded matcher and takes its best candidate, or reports that it
 * surfaced none. Used by routes that can legitimately proceed with no candidate
 * — the Opportunity Engine treats an absent candidate as an explainable,
 * hard-capped assessment rather than an error.
 */
export async function selectBestCandidate(
  ports: CandidateResolutionPorts,
  marketplaceProduct: MarketplaceProduct,
): Promise<CandidateSelection> {
  try {
    const matchResult = await ports.matchCandidates(marketplaceProduct);
    const best = matchResult.candidates[0];
    if (best === undefined) {
      return { status: "no-candidates", matchResult };
    }
    return { status: "selected", matchResult, candidate: best };
  } catch (error) {
    return { status: "supplier-error", error };
  }
}

