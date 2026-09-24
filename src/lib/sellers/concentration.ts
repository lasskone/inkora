/**
 * Deterministic product concentration over an observed seller sample.
 *
 * This module measures *repetition* in what a seller lists — how many distinct
 * product families the sample holds, and how concentrated the sample is in the
 * largest of them. It is deliberately a measurement of the catalog's shape:
 *
 * - **No sales are inferred.** A title repeated ten times means ten listings,
 *   never ten units sold.
 * - **No strategy is inferred.** A narrow sample is reported as narrow; whether
 *   the seller is a specialist, liquidating, or testing is a conclusion this
 *   evidence does not support.
 *
 * Pure on purpose: unit-testable with no network or credentials.
 */

import type {
  ProductConcentration,
  SellerListing,
  TitleFamily,
} from "./types";
import { familyKeyOf, familySampleTitle } from "./fingerprint";

/** Bound on the repeated-family rows returned; the long tail is noise here. */
const MAX_REPEATED_FAMILIES = 10;

/**
 * Distinct-family thresholds for the catalog-breadth classification, applied to
 * the observed sample only. Below `NARROW_MAX_FAMILIES` the seller's sample is
 * dominated by very few product families; at or above `BROAD_MIN_FAMILIES` it
 * spans many. The numbers are stated here so the classification is auditable.
 */
const NARROW_MAX_FAMILIES = 2;
const BROAD_MIN_FAMILIES = 6;

const SAMPLE_LIMITATION =
  "Concentration is measured over the observed sample only, never the seller's full catalog, and counts listings rather than sales.";

/**
 * Computes product concentration for a sample.
 *
 * Listings are grouped into product families by the deterministic title
 * fingerprint shared with cross-seller matching, so "the same family listed
 * twice" means one thing throughout the scanner.
 */
export function computeProductConcentration(
  listings: SellerListing[],
): ProductConcentration {
  const counts = new Map<string, { count: number; sampleTitle: string }>();

  for (const listing of listings) {
    const key = familyKeyOf(listing.title);
    if (key === null) continue;
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, {
        count: 1,
        sampleTitle: familySampleTitle(listing),
      });
    } else {
      existing.count += 1;
    }
  }

  const families = [...counts.entries()].sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return a[0].localeCompare(b[0]);
  });

  const distinctTitleFamilies = families.length;
  const classified = listings.length;
  const maxFamilyCount = families.length > 0 ? families[0][1].count : 0;
  const topFamilySharePercent =
    classified > 0 && families.length > 0
      ? Math.round((maxFamilyCount * 10_000) / classified) / 100
      : 0;

  const repeatedFamilies: TitleFamily[] = families
    .filter(([, value]) => value.count > 1)
    .slice(0, MAX_REPEATED_FAMILIES)
    .map(([key, value]) => ({
      key,
      sampleTitle: value.sampleTitle,
      listingCount: value.count,
    }));

  return {
    distinctTitleFamilies,
    repeatedFamilies,
    maxFamilyCount,
    topFamilySharePercent,
    catalogBreadth: classifyBreadth(distinctTitleFamilies, classified),
    sampledListingCount: listings.length,
    limitation: concentrationLimitation({
      classified,
      sampled: listings.length,
    }),
  };
}

/**
 * Maps a distinct-family count to a breadth label over the observed sample.
 *
 * A deterministic classification of the sample's shape, not a judgement of the
 * seller: the UI presents it alongside the counts that produced it.
 */
export function classifyBreadth(
  distinctFamilies: number,
  sampled: number,
): ProductConcentration["catalogBreadth"] {
  if (sampled === 0 || distinctFamilies === 0) return "narrow";
  if (distinctFamilies <= NARROW_MAX_FAMILIES) return "narrow";
  if (distinctFamilies >= BROAD_MIN_FAMILIES) return "broad";
  return "mixed";
}

function concentrationLimitation(args: {
  classified: number;
  sampled: number;
}): string {
  const parts = [SAMPLE_LIMITATION];
  if (args.classified !== args.sampled) {
    parts.push(
      `${args.sampled - args.classified} sampled listings could not be fingerprinted and are excluded from the family counts.`,
    );
  }
  return parts.join(" ");
}
