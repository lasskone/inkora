/**
 * Deterministic sorting and filtering of a seller's observed listings.
 *
 * Operates only on real, server-produced fields, over the bounded sample the
 * scan already returned — so re-sorting or filtering costs **zero** upstream
 * calls and never paginates again. Every ordering has a fully deterministic
 * tie-break ladder, so two identical samples always render in the same order.
 *
 * Sorting by *Opportunity Score* is deliberately not offered here: a score only
 * exists for a listing the user has evaluated through the Opportunity pipeline,
 * and a control that silently ordered by an absent value would misrepresent the
 * sample. Evaluation stays a separate, user-triggered action.
 *
 * Pure on purpose: unit-testable with no network.
 */

import { parseDecimalToCents } from "@/lib/economics/money";

import type { SellerListing } from "./types";

/** Sort keys the boundary recognizes; anything else is refused, not ignored. */
export const SELLER_SORT_KEYS = [
  "recent",
  "price-asc",
  "price-desc",
  "title",
  "category",
  "condition",
] as const;

export type SellerSortKey = (typeof SELLER_SORT_KEYS)[number];

export interface SellerListingFilters {
  categoryId?: string;
  condition?: string;
  minPriceCents?: number | null;
  maxPriceCents?: number | null;
}

/** True when the key is one the boundary knows how to order by. */
export function isValidSortKey(key: string): key is SellerSortKey {
  return (SELLER_SORT_KEYS as readonly string[]).includes(key);
}

/**
 * Orders the sample by the requested key. Never mutates the input.
 *
 * Tie-break ladder, applied after the primary key: the primary ordering, then
 * `externalId` ascending — a stable, server-assigned id that makes the whole
 * order reproducible regardless of arrival order.
 */
export function sortSellerListings(
  listings: SellerListing[],
  key: SellerSortKey,
): SellerListing[] {
  const ranked = [...listings];
  ranked.sort((a, b) => {
    const comparison = compareBy(a, b, key);
    return comparison !== 0
      ? comparison
      : a.externalId.localeCompare(b.externalId);
  });
  return ranked;
}

function compareBy(
  a: SellerListing,
  b: SellerListing,
  key: SellerSortKey,
): number {
  switch (key) {
    case "price-asc":
    case "price-desc": {
      const aCents = parseDecimalToCents(a.price);
      const bCents = parseDecimalToCents(b.price);
      // Unpriced listings sort last in both directions: they are not cheaper.
      if (aCents === null && bCents === null) return 0;
      if (aCents === null) return 1;
      if (bCents === null) return -1;
      return key === "price-asc" ? aCents - bCents : bCents - aCents;
    }
    case "recent": {
      // Newest listing-creation date first; undated listings sort last.
      const aTime = timeOrInfinity(a.itemCreationDate);
      const bTime = timeOrInfinity(b.itemCreationDate);
      return bTime - aTime;
    }
    case "title":
      return a.title.localeCompare(b.title);
    case "category":
      return categoryLabel(a).localeCompare(categoryLabel(b));
    case "condition":
      return conditionLabel(a).localeCompare(conditionLabel(b));
  }
}

/**
 * Filters the sample. An unrecognized filter value is a caller bug and rejected
 * rather than silently widening the result set.
 */
export function filterSellerListings(
  listings: SellerListing[],
  filters: SellerListingFilters,
): SellerListing[] {
  return listings.filter((listing) => {
    if (
      filters.categoryId !== undefined &&
      listing.primaryCategoryId !== filters.categoryId
    ) {
      return false;
    }
    if (
      filters.condition !== undefined &&
      !conditionsMatch(listing.condition, filters.condition)
    ) {
      return false;
    }
    const cents = parseDecimalToCents(listing.price);
    if (cents === null) {
      // An unpriced listing cannot satisfy a price range.
      if (filters.minPriceCents !== undefined && filters.minPriceCents !== null) {
        return false;
      }
      if (filters.maxPriceCents !== undefined && filters.maxPriceCents !== null) {
        return false;
      }
    } else {
      if (
        filters.minPriceCents !== undefined &&
        filters.minPriceCents !== null &&
        cents < filters.minPriceCents
      ) {
        return false;
      }
      if (
        filters.maxPriceCents !== undefined &&
        filters.maxPriceCents !== null &&
        cents > filters.maxPriceCents
      ) {
        return false;
      }
    }
    return true;
  });
}

/** The distinct condition values present in a sample, for filter controls. */
export function distinctConditions(listings: SellerListing[]): string[] {
  const values = new Set<string>();
  for (const listing of listings) {
    if (listing.condition !== null) values.add(listing.condition);
  }
  return [...values].sort();
}

/** The distinct categories present in a sample, for filter controls. */
export function distinctCategories(
  listings: SellerListing[],
): { categoryId: string; categoryName: string }[] {
  const seen = new Map<string, string>();
  for (const listing of listings) {
    if (listing.primaryCategoryId === null) continue;
    if (!seen.has(listing.primaryCategoryId)) {
      seen.set(
        listing.primaryCategoryId,
        listing.primaryCategoryName ?? listing.primaryCategoryId,
      );
    }
  }
  return [...seen.entries()]
    .map(([categoryId, categoryName]) => ({ categoryId, categoryName }))
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName));
}

function conditionsMatch(actual: string | null, requested: string): boolean {
  if (actual === null) return false;
  return actual.trim().toLowerCase() === requested.trim().toLowerCase();
}

function categoryLabel(listing: SellerListing): string {
  return listing.primaryCategoryName ??
    listing.primaryCategoryId ??
    "zzz-uncategorized";
}

function conditionLabel(listing: SellerListing): string {
  return listing.condition ?? "zzz-unspecified";
}

/**
 * Parses a listing's creation timestamp; an absent or unparseable one returns
 * `-Infinity` so undated listings sort *last* under `recent` (newest first)
 * rather than first, as a positive infinity sentinel would make them.
 */
function timeOrInfinity(timestamp: string | null): number {
  if (timestamp === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

