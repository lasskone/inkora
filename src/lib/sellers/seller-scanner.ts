import "server-only";

import type { MarketplaceProduct } from "@/lib/marketplace/types";

import { computeCategoryIntelligence } from "./categories";
import { summarizeListingChanges } from "./changes";
import { computeProductConcentration } from "./concentration";
import {
  SELLER_PERSISTENCE_CONCURRENCY,
  SELLER_SCAN_DEADLINE_MS,
  SELLER_SCANNER_VERSION,
  clampOverlapAnalyses,
  clampOverlapWindow,
  clampRecentLimit,
  clampSampleLimit,
  snapOffset,
} from "./limits";
import {
  deriveSellerProfile,
  normalizeSellerHandle,
  sampleBelongsToSeller,
} from "./normalize";
import { computePriceDistribution } from "./pricing";
import {
  computeCrossSellerEvidence,
  discoveryQueryForSeed,
  type OverlapObservation,
} from "./overlap";
import { familyKeyOf } from "./fingerprint";
import {
  observeSeller,
  observeSellerListings,
  readPreviouslySeenListingExternalIds,
  resolveSellerPersistence,
  type PersistenceOutcome,
} from "./seller-persistence";
import type {
  MarketplaceDiscoveryPort,
  SellerListingsPort,
  SellerListingsResult,
} from "./seller-ports";
import { sortSellerListings } from "./sorting";
import type {
  ComponentStatus,
  CrossSellerEvidence,
  ListingChangeReport,
  SellerIdentity,
  SellerListing,
  SellerScan,
  SellerScanLimits,
} from "./types";

/**
 * The Seller Scanner's orchestration boundary.
 *
 * One user action drives a **bounded, auditable** set of upstream calls and
 * composes the provider-independent result. Its governing rules:
 *
 * - **Bounded by design.** The sample, the recent page and the overlap analyses
 *   each cost a fixed number of marketplace calls, and deep Opportunity
 *   evaluation is *never* automatic — it stays a user action routed through the
 *   existing pipeline (docs/ARCHITECTURE.md §17).
 * - **Seller scoping is verified, not assumed.** The marketplace can answer a
 *   disliked seller filter with the *unfiltered* result set, so every returned
 *   listing is asserted to belong to the requested seller before it is used.
 * - **Partial failure is a state, not an error.** The recent view, history and
 *   overlap components each degrade independently; a scan that lost its overlap
 *   lookup still delivers listings, pricing, categories and concentration.
 * - **No invented metrics.** Everything here is observed, normalized or
 *   computed from the sample — never a sales, revenue or performance figure.
 */

/** The ports the orchestrator needs: a seller-scoped search and a discovery search. */
export interface SellerScanPorts {
  sellerListings: SellerListingsPort;
  discovery: MarketplaceDiscoveryPort;
}

/** A scan request after boundary validation, all bounds clamped server-side. */
export interface SellerScanRequest {
  readonly username: string;
  readonly query: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly recentLimit?: number;
  readonly overlapAnalyses?: number;
  readonly overlapWindow?: number;
}

/** The outcome the HTTP boundary maps to a response. */
export type SellerScanOutcome =
  | { status: "ok"; scan: SellerScan }
  | { status: "seller-not-found"; message: string }
  | { status: "upstream-error"; retryable: boolean; message: string };

/**
 * Runs one seller scan.
 *
 * Throws only for a genuinely unusable configuration; every recoverable problem
 * becomes a component status inside a successful scan or a typed outcome.
 */
export async function scanSeller(args: {
  ports: SellerScanPorts;
  request: SellerScanRequest;
  environment: string;
  now?: () => number;
}): Promise<SellerScanOutcome> {
  const startedAt = args.now?.() ?? Date.now();
  const observedAt = new Date(startedAt).toISOString();

  const normalizedHandle = normalizeSellerHandle(args.request.username);
  if (normalizedHandle === null) {
    return {
      status: "seller-not-found",
      message: "The seller identifier could not be normalized into a usable handle.",
    };
  }

  const limits: SellerScanLimits = {
    sampleLimit: clampSampleLimit(args.request.limit),
    recentLimit: clampRecentLimit(args.request.recentLimit),
    overlapWindow: clampOverlapWindow(args.request.overlapWindow),
    overlapAnalyses: clampOverlapAnalyses(args.request.overlapAnalyses),
  };
  const offset = snapOffset(args.request.offset, limits.sampleLimit);

  // --- 1. the seller's listing sample (1 marketplace call) -------------------
  let sample: SellerListingsResult;
  try {
    sample = await args.ports.sellerListings.searchSellerListings({
      query: args.request.query,
      sellerHandle: normalizedHandle,
      limit: limits.sampleLimit,
      offset,
      sort: undefined,
    });
  } catch (error) {
    return upstreamError(error);
  }

  // The marketplace may answer a rejected seller filter with the unfiltered
  // result set; either signal means the seller's listings were not delivered.
  if (
    sample.sellerFilterRejected ||
    !sampleBelongsToSeller(sample.listings, normalizedHandle)
  ) {
    return {
      status: "seller-not-found",
      message:
        "The marketplace did not scope results to that seller. The identifier may be wrong, or the seller has no listings in this search context.",
    };
  }

  const identity: SellerIdentity = {
    marketplace: "ebay",
    externalSellerId: normalizedHandle,
    username: sample.listings.length > 0 ? sample.listings[0].sellerName : null,
  };

  // --- 2. deterministic analysis over the sample (no upstream calls) ---------
  const seller = deriveSellerProfile({
    marketplace: "ebay",
    normalizedHandle,
    listings: sample.listings,
    observedListingCount: sample.total,
    observedAt,
  });
  const pricing = computePriceDistribution(sample.listings);
  const categories = computeCategoryIntelligence(sample.listings);
  const concentration = computeProductConcentration(sample.listings);
  const listings = sortSellerListings(sample.listings, "recent");

  // --- 3. recently added (1 marketplace call, the provider's own ordering) ---
  const components: ComponentStatus[] = [];
  const limitations: string[] = [];
  let recentListings: SellerListing[] | null = null;

  try {
    const recent = await args.ports.sellerListings.searchSellerListings({
      query: args.request.query,
      sellerHandle: normalizedHandle,
      limit: limits.recentLimit,
      offset: 0,
      sort: "newlyListed",
    });
    if (!recent.sellerFilterRejected && sampleBelongsToSeller(recent.listings, normalizedHandle)) {
      recentListings = recent.listings;
      components.push({
        component: "recent-listings",
        status: "ok",
        message:
          "Ordered by the marketplace's own listing-creation timestamp (newest first).",
      });
    } else {
      components.push({
        component: "recent-listings",
        status: "unavailable",
        message: "The newest-listed view could not be scoped to this seller.",
      });
    }
  } catch (error) {
    components.push({
      component: "recent-listings",
      status: "unavailable",
      message: describeFailure(error, "the recently-added view"),
    });
  }

  // --- 4. persistence + listing history (best effort, never fatal) ----------
  const listingChanges = await persistAndCompare({
    identity,
    listings: sample.listings,
    observedAt,
    seller,
    contextQuery: args.request.query,
    limits,
  });
  components.push(listingChanges.component);
  if (listingChanges.limitation !== null) {
    limitations.push(listingChanges.limitation);
  }

  // --- 5. cross-seller overlap (bounded, budget-checked) --------------------
  const overlap = await analyzeCrossSellerOverlap({
    ports: args.ports,
    seedListings: recentListings ?? listings,
    sellerName: identity.username,
    overlapAnalyses: limits.overlapAnalyses,
    overlapWindow: limits.overlapWindow,
    observedAt,
    startedAt,
  });
  components.push(overlap.component);
  for (const evidence of overlap.evidence) {
    limitations.push(
      `Cross-seller evidence for "${evidence.seed.title}" is bounded to its discovery window and is not a demand measure.`,
    );
  }

  // --- 6. assemble ----------------------------------------------------------
  const ebaySearchCalls = 2 + overlap.calls;
  const elapsedMs = (args.now?.() ?? Date.now()) - startedAt;

  const scan: SellerScan = {
    seller,
    observedAt,
    listings,
    listingSample: {
      sampledCount: sample.listings.length,
      observedTotal: sample.total,
      limit: limits.sampleLimit,
      offset,
      contextQuery: args.request.query,
    },
    categories,
    pricing,
    concentration,
    recentListings,
    listingChanges: listingChanges.report,
    crossSellerEvidence: overlap.evidence,
    components,
    limitations: [
      ...limitations,
      ...baseLimitations({
        sampled: sample.listings.length,
        observedTotal: sample.total,
      }),
    ],
    meta: {
      version: SELLER_SCANNER_VERSION,
      environment: args.environment,
      limits,
      upstreamCalls: { ebaySearch: ebaySearchCalls, supabaseWrites: listingChanges.writes },
      elapsedMs,
    },
  };

  return { status: "ok", scan };
}

// --- persistence + history ---------------------------------------------------

/**
 * Stores the seller and listing observations, then derives the change report
 * from what was stored. Persistence is best-effort throughout: a disabled or
 * failed store degrades the history component, never the scan.
 */
async function persistAndCompare(args: {
  identity: SellerIdentity;
  listings: SellerListing[];
  observedAt: string;
  seller: SellerScan["seller"];
  contextQuery: string;
  limits: SellerScanLimits;
}): Promise<{
  report: ListingChangeReport;
  component: ComponentStatus;
  limitation: string | null;
  writes: number;
}> {
  const client = resolveSellerPersistence();
  if (client === null) {
    return {
      report: {
        histories: [],
        availability: "disabled",
        note: "Persistence is not configured on this server, so no listing history was compared.",
      },
      component: {
        component: "listing-changes",
        status: "skipped",
        message: "Persistence is not configured; history is unavailable for this scan.",
      },
      limitation:
        "Listing-change history is unavailable because persistence is not configured on this server.",
      writes: 0,
    };
  }

  const previouslySeen = await readPreviouslySeenListingExternalIds(
    client,
    args.identity.externalSellerId,
  );

  const stored = await observeSellerListings({
    client,
    listings: args.listings,
    observedAt: args.observedAt,
    concurrency: SELLER_PERSISTENCE_CONCURRENCY,
  });

  // `result.previous` is the observation stored *just before* this scan appended
  // — the genuine baseline change detection must compare against. Rebuilding it
  // from the current listing instead would compare the scan against itself, so a
  // real price or title change could never be seen and the shipping comparison
  // alone would manufacture phantom changes every rescan.
  const storedById = new Map(
    stored.results.map((result) => [
      result.externalId,
      { firstSeenAt: result.firstSeenAt, latest: result.previous },
    ]),
  );

  // Listings seen before but absent from this bounded sample are reported as
  // absent — never as delisted.
  for (const externalId of previouslySeen) {
    if (!storedById.has(externalId)) {
      storedById.set(externalId, {
        firstSeenAt: null,
        latest: null,
      });
    }
  }

  const report = summarizeListingChanges({
    current: args.listings,
    stored: storedById,
    currentObservedAt: args.observedAt,
    persistenceAvailable: true,
  });

  const sellerObservation = await observeSeller({
    client,
    identity: args.identity,
    feedbackPercentage: args.seller.feedbackPercentage,
    feedbackScore: args.seller.feedbackScore,
    observedListingCount: args.seller.observedListingCount,
    sampledListingCount: args.seller.sampledListingCount,
    contextQuery: args.contextQuery,
    observedAt: args.observedAt,
  });

  const writes =
    stored.stored +
    (sellerObservation.status === "ok" && sellerObservation.inserted ? 1 : 0);

  const limitation = persistenceLimitation(sellerObservation, stored.failed);
  const status: ComponentStatus["status"] =
    stored.failed === 0 && sellerObservation.status !== "failed" ? "ok" : "unavailable";

  return {
    report,
    component: {
      component: "listing-changes",
      status,
      message:
        report.availability === "history"
          ? `${stored.stored} new listing observations appended this scan.`
          : report.availability === "no-history"
            ? "No prior listing observations existed to compare against."
            : report.note,
    },
    limitation,
    writes,
  };
}

/** Honest prose for a persistence outcome that was less than fully successful. */
function persistenceLimitation(
  sellerObservation: PersistenceOutcome,
  failedListings: number,
): string | null {
  if (sellerObservation.status === "disabled") {
    return "Persistence is not configured, so this scan's observations were not stored and no future comparison is possible.";
  }

  const parts: string[] = [];
  if (sellerObservation.status === "failed") {
    parts.push(`The seller observation could not be stored: ${sellerObservation.message}`);
  }
  if (failedListings > 0) {
    parts.push(
      `${failedListings} listing observations could not be stored; their history comparison is unavailable.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

// --- cross-seller overlap ------------------------------------------------------

/**
 * Runs bounded cross-seller discovery for the scan's most representative
 * listings.
 *
 * Seeds are taken from the newest-first view when available, deduplicated to
 * distinct product families so the budget buys breadth rather than three copies
 * of one product. Each analysis costs exactly one marketplace search, and the
 * whole component stops at the scan's wall-clock budget, reporting the remaining
 * analyses as skipped rather than silently omitting them.
 */
async function analyzeCrossSellerOverlap(args: {
  ports: SellerScanPorts;
  seedListings: SellerListing[];
  sellerName: string | null;
  overlapAnalyses: number;
  overlapWindow: number;
  observedAt: string;
  startedAt: number;
}): Promise<{
  evidence: CrossSellerEvidence[];
  calls: number;
  component: ComponentStatus;
}> {
  if (args.overlapAnalyses <= 0 || args.seedListings.length === 0) {
    return {
      evidence: [],
      calls: 0,
      component: {
        component: "cross-seller-overlap",
        status: "skipped",
        message:
          args.seedListings.length === 0
            ? "No listings to analyze for cross-seller overlap."
            : "Cross-seller overlap analysis is disabled for this scan.",
      },
    };
  }

  const seeds = pickDistinctFamilySeeds(args.seedListings, args.overlapAnalyses);
  const evidence: CrossSellerEvidence[] = [];
  let calls = 0;
  let skipped = 0;
  let failed = 0;

  for (const seed of seeds) {
    const elapsed = Date.now() - args.startedAt;
    if (elapsed > SELLER_SCAN_DEADLINE_MS) {
      skipped += seeds.length - evidence.length - failed;
      break;
    }

    const discoveryQuery = discoveryQueryForSeed(seed.title);
    if (discoveryQuery === null) {
      // A title with too little signal is not a discovery candidate.
      continue;
    }

    let products: MarketplaceProduct[];
    try {
      const result = await args.ports.discovery.search({
        query: discoveryQuery,
        limit: args.overlapWindow,
        offset: 0,
      });
      products = result.products;
      calls += 1;
    } catch {
      failed += 1;
      continue;
    }

    evidence.push(
      computeCrossSellerEvidence({
        seed: { externalId: seed.externalId, title: seed.title },
        sellerName: args.sellerName,
        window: products.map(toOverlapObservation),
        discoveryQuery,
        observedAt: args.observedAt,
      }),
    );
  }

  const status: ComponentStatus["status"] =
    evidence.length > 0 ? "ok" : failed > 0 ? "unavailable" : "skipped";
  const message =
    evidence.length > 0
      ? `${evidence.length} product famil${evidence.length === 1 ? "y" : "ies"} analyzed for independent-seller overlap (${calls} marketplace call${calls === 1 ? "" : "s"}).`
      : failed > 0
        ? "Cross-seller discovery calls failed; overlap evidence is unavailable for this scan."
        : "No seed listing produced a usable discovery query, so no overlap was analyzed.";

  if (skipped > 0) {
    return {
      evidence,
      calls,
      component: {
        component: "cross-seller-overlap",
        status: "ok",
        message: `${message} ${skipped} analyses were skipped because the scan's time budget elapsed.`,
      },
    };
  }

  return {
    evidence,
    calls,
    component: { component: "cross-seller-overlap", status, message },
  };
}

/**
 * The first N listings belonging to *distinct* product families, in the input's
 * own order — so the overlap budget examines breadth, not repetition.
 */
function pickDistinctFamilySeeds(
  listings: SellerListing[],
  count: number,
): SellerListing[] {
  const seeds: SellerListing[] = [];
  const seenFamilies = new Set<string>();
  for (const listing of listings) {
    const key = familyKeyOrFallback(listing.title, listing.externalId);
    if (seenFamilies.has(key)) continue;
    seenFamilies.add(key);
    seeds.push(listing);
    if (seeds.length >= count) break;
  }
  return seeds;
}

// --- error mapping ------------------------------------------------------------

/** Maps a thrown marketplace error into the scan's typed outcome. */
function upstreamError(error: unknown): SellerScanOutcome {
  const message = describeFailure(error, "the seller listing search");
  return {
    status: "upstream-error",
    retryable: isRetryable(error),
    message,
  };
}

/** A secret-free description of a failure, safe to return to the browser. */
function describeFailure(error: unknown, context: string): string {
  if (error === null || typeof error !== "object") {
    return `A failure prevented ${context}.`;
  }
  const candidate = error as { message?: unknown; name?: string };
  if (typeof candidate.message === "string" && candidate.message.length > 0) {
    return candidate.message;
  }
  return `${candidate.name ?? "An error"} prevented ${context}.`;
}

/**
 * True when a failure is plausibly transient, so the boundary can advise retry.
 * The marketplace error classes mark themselves; anything unmarked is treated as
 * non-retryable rather than assumed recoverable.
 */
function isRetryable(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { retryable?: unknown };
  return candidate.retryable === true;
}

/** The limitations every scan carries, independent of its components. */
function baseLimitations(args: {
  sampled: number;
  observedTotal: number | null;
}): string[] {
  return [
    "Counts, categories, pricing and concentration describe the observed sample only. The marketplace enumerates a seller's listings within a search context and a page size, never the seller's full inventory.",
    "Nothing in this result is a sales, revenue or demand measure; the marketplace does not expose those figures and Inkora does not derive them from listing presence.",
    ...(args.observedTotal === null
      ? ["The marketplace did not report a total for this context, so the sample is unbounded by a known result-set size."]
      : []),
  ];
}


function familyKeyOrFallback(title: string, externalId: string): string {
  const key = familyKeyOf(title);
  return key ?? `unfingerprintable:${externalId}`;
}

function toOverlapObservation(product: MarketplaceProduct): OverlapObservation {
  return {
    externalId: product.externalId,
    title: product.title,
    sellerName: product.sellerName,
  };
}

