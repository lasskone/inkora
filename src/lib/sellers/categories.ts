/**
 * Deterministic category intelligence over an observed seller sample.
 *
 * Aggregates the marketplace's own category path (eBay returns a leaf-first list
 * per item summary) and reports the share of the *sample* each category holds.
 *
 * The single honesty rule that governs this module: **the marketplace does not
 * enumerate a seller's inventory.** A seller-scoped search is bounded by a
 * context (keyword, category, gtin or epid) and by a page size, so these counts
 * describe the observed sample, never the seller's complete business. The
 * limitation is attached to every result, and the UI repeats it.
 *
 * Pure on purpose: unit-testable with no network or credentials.
 */

import type {
  CategoryBreakdown,
  CategoryIntelligence,
  SellerListing,
} from "./types";

/** The bound on the breakdown the API returns; the tail is detail, not signal. */
const MAX_CATEGORY_ROWS = 20;

const SAMPLE_LIMITATION =
  "Counts describe the observed sample only. A seller's listings can be enumerated within a search context and a page size, not in full, so this is not the seller's complete category distribution.";

/**
 * Computes the category breakdown of a sample, most-represented first.
 *
 * Listings with no category at all are counted in `uncategorized` and excluded
 * from the shares; the denominator is always the number of listings that carried
 * a category, so the percentages sum to 100 of what was actually classifiable.
 */
export function computeCategoryIntelligence(
  listings: SellerListing[],
): CategoryIntelligence {
  const counts = new Map<string, { name: string; count: number }>();
  let categorized = 0;
  let uncategorized = 0;

  for (const listing of listings) {
    const categoryId = listing.primaryCategoryId;
    if (categoryId === null) {
      uncategorized += 1;
      continue;
    }
    categorized += 1;
    const existing = counts.get(categoryId);
    if (existing === undefined) {
      counts.set(categoryId, {
        name: listing.primaryCategoryName ?? categoryId,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }

  const denominator = categorized;
  const categories: CategoryBreakdown[] = [...counts.entries()]
    .map(([categoryId, value]) => ({
      categoryId,
      categoryName: value.name,
      listingCount: value.count,
      sharePercent: shareOf(value.count, denominator),
    }))
    .sort((a, b) =>
      b.listingCount !== a.listingCount
        ? b.listingCount - a.listingCount
        : a.categoryId.localeCompare(b.categoryId),
    )
    .slice(0, MAX_CATEGORY_ROWS);

  const dominant = categories.length > 0 ? categories[0] : null;

  return {
    categories,
    dominantCategory: dominant,
    distinctCategoryCount: counts.size,
    sampledListingCount: listings.length,
    limitation: categoryLimitation({
      denominator,
      uncategorized,
      sampled: listings.length,
    }),
  };
}

/**
 * Share of the sample, in percent, rounded to two decimals. `null` when no
 * denominator exists (a sample where nothing carried a category).
 */
export function shareOf(count: number, denominator: number): number {
  if (denominator <= 0) return 0;
  // Percent with two decimals of precision from a single half-up rounding, so
  // the shares of a sample always sum to 100.00 within rounding.
  return Math.round((count * 10_000) / denominator) / 100;
}

function categoryLimitation(args: {
  denominator: number;
  uncategorized: number;
  sampled: number;
}): string {
  const parts = [SAMPLE_LIMITATION];
  if (args.uncategorized > 0) {
    parts.push(
      `${args.uncategorized} of ${args.sampled} sampled listings carried no category and are excluded from the shares.`,
    );
  }
  return parts.join(" ");
}
