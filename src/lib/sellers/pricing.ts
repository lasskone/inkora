/**
 * Deterministic price distribution over a bounded seller sample.
 *
 * Statistics are computed in **integer minor units** through the project's
 * existing money primitives (docs/ARCHITECTURE.md §10.1): a price is a decimal
 * string at the boundary, becomes cents for arithmetic, and is formatted back
 * to a decimal string for the API and UI. Binary floating point is never
 * introduced, so a median of `19.99` and `20.01` is exactly `20.00`, not
 * `20.000000000000004`.
 *
 * Two rules keep this honest:
 *
 * 1. **Mixed currency is refused, not averaged.** Averaging USD and EUR prices
 *    without an FX conversion would fabricate a figure, so the module reports
 *    the currencies it saw and declines to produce statistics.
 * 2. **A price distribution is never sales performance.** It describes the
 *    *listed prices* of an observed sample and is labeled as such everywhere it
 *    appears.
 *
 * Pure on purpose: every statistic is unit-testable with no network.
 */

import { formatCents, parseDecimalToCents } from "@/lib/economics/money";

import type { PriceDistribution, SellerListing } from "./types";

/**
 * Computes the price distribution of a sample.
 *
 * Listings without an interpretable price are excluded from every statistic and
 * reported in `unpricedCount`, because "no price" is not "free".
 */
export function computePriceDistribution(
  listings: SellerListing[],
): PriceDistribution {
  const currencies = new Set<string>();
  const pricedCents: number[] = [];

  for (const listing of listings) {
    if (listing.currency !== null) currencies.add(listing.currency);
    const cents = parseDecimalToCents(listing.price);
    if (cents === null) continue;
    pricedCents.push(cents);
  }

  const currencyList = [...currencies];
  const mixedCurrencies = currencyList.length > 1;
  const currency = currencyList.length === 1 ? currencyList[0] : null;

  if (mixedCurrencies || pricedCents.length === 0) {
    return {
      currency,
      pricedCount: pricedCents.length,
      unpricedCount: listings.length - pricedCents.length,
      min: null,
      max: null,
      median: null,
      mean: null,
      quartiles: { q1: null, q3: null },
      currencies: currencyList,
      mixedCurrencies,
      limitation: priceLimitation({
        mixedCurrencies,
        pricedCount: pricedCents.length,
        currencies: currencyList,
      }),
    };
  }

  // Deterministic order: the input sample order is arbitrary, so every
  // order-statistic is computed over the sorted cent array.
  const sorted = [...pricedCents].sort((a, b) => a - b);

  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = quantile(sorted, 0.5);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const mean = roundHalfUpCents(total / sorted.length);

  return {
    currency,
    pricedCount: sorted.length,
    unpricedCount: listings.length - sorted.length,
    min: formatCents(min),
    max: formatCents(max),
    median: formatCents(median),
    mean: formatCents(mean),
    quartiles: { q1: formatCents(q1), q3: formatCents(q3) },
    currencies: currencyList,
    mixedCurrencies: false,
    limitation: null,
  };
}

/**
 * The price spread as a ratio, or `null` when a spread is not computable.
 *
 * Exposed as a deterministic derived figure the UI can use to describe a sample
 * ("prices span 4.2x") without ever presenting it as a sales metric.
 */
export function priceSpreadRatio(distribution: PriceDistribution): number | null {
  if (distribution.min === null || distribution.max === null) return null;
  const min = parseDecimalToCents(distribution.min);
  const max = parseDecimalToCents(distribution.max);
  if (min === null || max === null || min <= 0) return null;
  return max / min;
}

/**
 * One order statistic of a sorted cent array, with linear interpolation between
 * the two adjacent ranks — the standard deterministic definition, so a sample of
 * 3 prices has a reproducible median regardless of how it was fetched.
 */
function quantile(sortedCents: number[], q: number): number {
  if (sortedCents.length === 1) return sortedCents[0];

  const position = q * (sortedCents.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return roundHalfUpCents(sortedCents[lower]);

  const fraction = position - lower;
  const interpolated =
    sortedCents[lower] + fraction * (sortedCents[upper] - sortedCents[lower]);
  return roundHalfUpCents(interpolated);
}

/** Rounds to the nearest cent, half up, matching the money module's convention. */
function roundHalfUpCents(value: number): number {
  // Prices are non-negative, so floor(x + 0.5) is exact half-up rounding and
  // never lands on the wrong side of a tie.
  return Math.floor(value + 0.5);
}

function priceLimitation(args: {
  mixedCurrencies: boolean;
  pricedCount: number;
  currencies: string[];
}): string | null {
  if (args.mixedCurrencies) {
    return `The sample mixed currencies (${args.currencies.join(
      ", ",
    )}); statistics are refused rather than averaging across currencies without a conversion.`;
  }
  if (args.pricedCount === 0) {
    return "None of the sampled listings carried an interpretable price, so no price distribution could be computed.";
  }
  return null;
}
