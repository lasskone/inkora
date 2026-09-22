/**
 * The **competition** component: what the sampled search window says about how
 * crowded this opportunity is.
 *
 * Every figure here comes from **one sampled page of one query**, replayed from
 * the search window the product scanner already fetched (docs/API_INTEGRATIONS.md
 * §3). V1 spends zero additional eBay API calls on competition evidence, which
 * keeps the engine inside the scanner's existing rate-limit budget.
 *
 * Because the evidence is sampled and query-relative, this module never reports
 * a market census. It reports an *appearance* — hence the verdict names — and it
 * carries the query with the result, because a result count for "wireless
 * earbuds" and one for a specific model number are not comparable numbers
 * (docs/ARCHITECTURE.md §9.2).
 *
 * Pure: identical inputs ⇒ identical output.
 */

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type {
  CompetitionAssessment,
  CompetitionVerdict,
  OpportunityInput,
} from "./types";
import {
  COMPETITION_INTENSITY_WEIGHTS,
  COMPETITION_VERDICT_THRESHOLDS,
  SIMILAR_PRICE_BAND,
} from "./types";
import { parseDecimalToCents } from "@/lib/economics/money";

/** The inspected window, with the listing's own row removed. */
interface CompetitionSample {
  listings: MarketplaceProduct[];
  /** Provider-reported total for the query, or `null` when the provider gave none. */
  total: number | null;
}

/**
 * Extracts and bounds the sample. The listing being assessed is *removed* when
 * it appears in its own search window — which is the normal case — because a
 * listing is not competition with itself.
 */
function buildSample(input: OpportunityInput): CompetitionSample | null {
  if (input.competition === null) return null;
  const others = input.competition.searchResult.products.filter(
    (product) => product.externalId !== input.marketplaceProduct.externalId,
  );
  return {
    listings: others.slice(0, Math.max(0, input.limits.maxCompetitionSample)),
    total: input.competition.searchResult.total,
  };
}

/** Maps a provider total onto a 0–100 breadth sub-score. */
function breadthFromTotal(total: number | null): number {
  if (total === null) return 0;
  if (total < 25) return 10;
  if (total < 100) return 25;
  if (total < 500) return 45;
  if (total < 2_000) return 65;
  if (total < 10_000) return 80;
  return 90;
}

/** Distinct sellers among the inspected listings. */
function distinctSellerCount(listings: MarketplaceProduct[]): number {
  const sellers = new Set(
    listings
      .map((listing) => listing.sellerName)
      .filter((name): name is string => name !== null && name.trim() !== ""),
  );
  return sellers.size;
}

/**
 * Crowding sub-score from the *number* of distinct merchants in the inspected
 * window.
 *
 * A seller *ratio* would say "every listing is from a different seller", which
 * is a thin claim when the window holds three listings — and it would call a
 * three-listing window as crowded as a fifty-listing one. An absolute ladder
 * instead states how many independent competitors were actually seen, which is
 * the honest reading of a bounded sample.
 */
function crowdingFromSellers(sellers: number): number {
  if (sellers === 0) return 0;
  if (sellers === 1) return 20;
  if (sellers === 2) return 32;
  if (sellers === 3) return 42;
  if (sellers <= 6) return 55;
  if (sellers <= 12) return 68;
  if (sellers <= 25) return 80;
  return 90;
}

/**
 * Price-proximity sub-score: how many inspected offers a buyer would actually
 * compare against this one, priced within `SIMILAR_PRICE_BAND` of it.
 */
function priceProximity(listings: MarketplaceProduct[], own: MarketplaceProduct): number {
  const ownCents = parseDecimalToCents(own.price);
  if (ownCents === null || ownCents <= 0 || listings.length === 0) return 0;
  const low = ownCents * SIMILAR_PRICE_BAND.low;
  const high = ownCents * SIMILAR_PRICE_BAND.high;
  const near = listings.filter((listing) => {
    const cents = parseDecimalToCents(listing.price);
    return cents !== null && cents >= low && cents <= high;
  }).length;
  return Math.round((near / listings.length) * 100);
}

function verdictFromIntensity(intensity: number): CompetitionVerdict {
  if (intensity >= COMPETITION_VERDICT_THRESHOLDS.broad) return "APPEARS_BROAD";
  if (intensity >= COMPETITION_VERDICT_THRESHOLDS.limited) return "APPEARS_MODERATE";
  return "APPEARS_LIMITED";
}

function isNewCondition(listing: MarketplaceProduct): boolean {
  return listing.condition !== null && listing.condition.trim().toUpperCase() === "NEW";
}

/**
 * Builds the competition component. A `null` competition input — or an empty
 * window — produces `INSUFFICIENT_EVIDENCE` rather than a guess, and the query
 * is always carried so the figure stays attributable.
 */
export function assessCompetition(input: OpportunityInput): CompetitionAssessment {
  const sample = buildSample(input);
  const query = input.competition?.query ?? "";

  if (sample === null) {
    return insufficient(query, [
      "No competition evidence was supplied with this assessment, so no competition figure was estimated.",
    ]);
  }
  if (sample.listings.length === 0 && sample.total === null) {
    return insufficient(query, [
      "The sampled search window contained no other listings and the provider reported no result total.",
    ]);
  }

  const own = input.marketplaceProduct;
  const sellers = distinctSellerCount(sample.listings);
  const proximity = priceProximity(sample.listings, own);

  const intensity = Math.round(
    breadthFromTotal(sample.total) * COMPETITION_INTENSITY_WEIGHTS.breadth +
      crowdingFromSellers(sellers) * COMPETITION_INTENSITY_WEIGHTS.crowding +
      proximity * COMPETITION_INTENSITY_WEIGHTS.priceProximity,
  );

  return {
    verdict: verdictFromIntensity(intensity),
    intensity,
    score: 100 - intensity,
    query,
    searchResultTotal: sample.total,
    sampleSize: sample.listings.length,
    distinctSellers: sellers,
    similarlyPricedListings:
      proximity === 0 ? 0 : Math.round((proximity / 100) * sample.listings.length),
    newConditionListings: sample.listings.filter(isNewCondition).length,
    caveats: buildCaveats(sample),
  };
}

/** The `INSUFFICIENT_EVIDENCE` shape, with zeroed figures and its reasons. */
function insufficient(query: string, caveats: string[]): CompetitionAssessment {
  return {
    verdict: "INSUFFICIENT_EVIDENCE",
    intensity: 0,
    score: 0,
    query,
    searchResultTotal: null,
    sampleSize: 0,
    distinctSellers: 0,
    similarlyPricedListings: 0,
    newConditionListings: 0,
    caveats,
  };
}

/**
 * Caveats that always travel with a competition figure, because the figure is
 * only meaningful with them attached.
 */
function buildCaveats(sample: CompetitionSample): string[] {
  const caveats = [
    "Competition figures describe one sampled page of one search query, not a census of the market.",
    "This assessment's own listing is excluded from the sample.",
  ];
  if (sample.total === null) {
    caveats.push(
      "The provider reported no total result count for this query, so breadth is measured from the sampled listings only.",
    );
  }
  if (sample.listings.some((listing) => listing.sellerName === null)) {
    caveats.push(
      "Some sampled listings expose no seller identifier, so the distinct-seller count is a lower bound.",
    );
  }
  return caveats;
}

