/**
 * Pure normalization helpers for the provider-independent seller model.
 *
 * Two responsibilities, both deterministic and side-effect free:
 *
 * 1. turning a user-typed seller handle into a stable identity that history can
 *    be anchored to;
 * 2. deriving a seller profile from the listings a scan actually observed.
 *
 * The marketplace mapping itself (raw provider payload → `SellerListing`) lives
 * in the adapter, never here, so provider specifics never leak into the seller
 * intelligence layer (docs/ARCHITECTURE.md §4).
 *
 * Pure on purpose: every rule here is unit-testable with no network and no
 * credentials.
 */

import type { MarketplaceId } from "@/lib/marketplace/types";

import type {
  SellerIdentity,
  SellerListing,
  SellerProfile,
} from "./types";

/**
 * Characters a seller handle may contain. Deliberately an allowlist: the handle
 * is interpolated into a marketplace query filter, so anything outside it is
 * refused rather than escaped. Letters (any script) and digits cover the
 * overwhelming majority of real seller handles; `.`, `_` and `-` are the common
 * separators.
 */
const SELLER_HANDLE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/**
 * Returns the normalized handle, or `null` when the input cannot be a seller
 * handle at all.
 *
 * Normalization is trim + whitespace collapse + lowercase. Lowercasing is safe:
 * the marketplace's seller filter is case-insensitive (verified against the
 * live API), so one canonical spelling becomes the history key and a user's
 * stray capitalization never creates a second identity.
 */
export function normalizeSellerHandle(input: string): string | null {
  if (typeof input !== "string") return null;
  const collapsed = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (collapsed.length === 0 || collapsed.length > 64) return null;
  if (!SELLER_HANDLE_PATTERN.test(collapsed)) return null;
  return collapsed;
}

/** Builds the stable identity from an already-normalized handle. */
export function sellerIdentity(
  marketplace: MarketplaceId,
  normalizedHandle: string,
  username: string | null,
): SellerIdentity {
  return {
    marketplace,
    externalSellerId: normalizedHandle,
    username,
  };
}

/**
 * Derives a seller profile from the listings a scan actually observed.
 *
 * Feedback is read off the listing summaries because that is where the
 * marketplace returns it — eBay emits one identical seller block on every item
 * summary of a seller-scoped search. The values are the provider's own, so the
 * provenance is OFFICIAL; the counts are observations of a bounded,
 * context-scoped sample, so they are OBSERVED.
 *
 * Never invents a figure: a seller the search could not observe (zero listings
 * in the context) yields `null` feedback fields and a profile that says so.
 */
export function deriveSellerProfile(args: {
  marketplace: MarketplaceId;
  normalizedHandle: string;
  listings: SellerListing[];
  observedListingCount: number | null;
  observedAt: string;
}): SellerProfile {
  const consensus = consensusSellerBlock(args.listings);

  return {
    marketplace: args.marketplace,
    externalSellerId: args.normalizedHandle,
    username: consensus.username,
    feedbackScore: consensus.feedbackScore,
    feedbackPercentage: consensus.feedbackPercentage,
    observedListingCount: args.observedListingCount,
    sampledListingCount: args.listings.length,
    provenance: {
      feedback: "OFFICIAL",
      counts: "OBSERVED",
    },
    observedAt: args.observedAt,
  };
}

/**
 * The seller block every observed listing agrees on.
 *
 * A divergence is evidence of a problem, not something to average away: if the
 * sampled listings disagree about who the seller is, the scan was not actually
 * scoped to one seller, so the block is reported as unresolvable (`null`) and
 * the caller must treat the scan as inconclusive rather than trusting a blend.
 */
export function consensusSellerBlock(listings: SellerListing[]): {
  username: string | null;
  feedbackScore: number | null;
  feedbackPercentage: number | null;
} {
  if (listings.length === 0) {
    return { username: null, feedbackScore: null, feedbackPercentage: null };
  }

  const usernames = new Set<string>();
  const feedbackScores = new Set<number>();
  const feedbackPercentages = new Set<number>();

  for (const listing of listings) {
    if (listing.sellerName !== null) usernames.add(listing.sellerName);
    if (listing.sellerFeedbackScore !== null) {
      feedbackScores.add(listing.sellerFeedbackScore);
    }
    if (listing.sellerFeedbackPercentage !== null) {
      feedbackPercentages.add(listing.sellerFeedbackPercentage);
    }
  }

  // More than one distinct seller across the sample means the search was not
  // seller-scoped; refuse to summarize it as one seller.
  if (usernames.size > 1) {
    return { username: null, feedbackScore: null, feedbackPercentage: null };
  }

  return {
    username: usernames.size === 1 ? [...usernames][0] : null,
    feedbackScore: feedbackScores.size === 1 ? [...feedbackScores][0] : null,
    feedbackPercentage:
      feedbackPercentages.size === 1 ? [...feedbackPercentages][0] : null,
  };
}

/**
 * True when every listing in the sample belongs to the normalized handle.
 *
 * The marketplace's seller filter can degrade *silently* to unfiltered results
 * when it dislikes a handle (verified against the live API: it warns, returns
 * HTTP 200 and hands back the whole result set). That failure mode must never
 * become "here is your seller" for someone else's inventory, so the scanner
 * asserts the provenance of every row it keeps.
 */
export function sampleBelongsToSeller(
  listings: SellerListing[],
  normalizedHandle: string,
): boolean {
  if (listings.length === 0) return true;
  return listings.every(
    (listing) =>
      listing.sellerName !== null &&
      listing.sellerName.trim().toLowerCase() === normalizedHandle,
  );
}
