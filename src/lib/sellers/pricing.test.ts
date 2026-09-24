/**
 * Unit tests for the price distribution over a bounded seller sample.
 *
 * Statistics are integer minor units end to end, so the median of 19.99 and
 * 20.01 is exactly 20.00 here — the test that would fail the day a float sneaks
 * into the pipeline. See `src/lib/sellers/pricing.ts`.
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { SellerListing } from "./types";
import { computePriceDistribution, priceSpreadRatio } from "./pricing";

/** Minimal priced listing; only price and currency feed the distribution. */
function priced(price: string | null, currency: string | null, externalId: string): SellerListing {
  return {
    marketplace: "ebay",
    externalId,
    title: `Listing ${externalId}`,
    imageUrl: null,
    listingUrl: null,
    price,
    currency,
    condition: null,
    conditionId: null,
    sellerName: "inkora-store",
    sellerFeedbackPercentage: null,
    sellerFeedbackScore: null,
    shippingCost: null,
    shippingCurrency: null,
    location: null,
    primaryCategoryId: null,
    primaryCategoryName: null,
    categories: [],
    buyingOptions: [],
    itemCreationDate: null,
    itemEndDate: null,
    epid: null,
    provenance: "OBSERVED",
    fetchedAt: "2026-01-01T00:00:00Z",
  };
}

describe("computePriceDistribution", () => {
  it("computes every order statistic of a single-currency sample", () => {
    const distribution = computePriceDistribution([
      priced("10.00", "USD", "2"),
      priced("30.00", "USD", "3"),
      priced("20.00", "USD", "1"),
    ]);

    assert.equal(distribution.currency, "USD");
    assert.equal(distribution.pricedCount, 3);
    assert.equal(distribution.unpricedCount, 0);
    assert.equal(distribution.min, "10.00");
    assert.equal(distribution.max, "30.00");
    assert.equal(distribution.median, "20.00");
    assert.equal(distribution.mean, "20.00");
    assert.equal(distribution.quartiles.q1, "15.00");
    assert.equal(distribution.quartiles.q3, "25.00");
    assert.deepEqual(distribution.currencies, ["USD"]);
    assert.equal(distribution.mixedCurrencies, false);
    assert.equal(distribution.limitation, null);
  });

  it("never introduces binary floating point at a tie", () => {
    const distribution = computePriceDistribution([
      priced("19.99", "USD", "1"),
      priced("20.01", "USD", "2"),
    ]);
    assert.equal(distribution.median, "20.00");
    assert.equal(distribution.mean, "20.00");
  });

  it("excludes unpriced listings from every statistic and reports the count", () => {
    const distribution = computePriceDistribution([
      priced("10.00", "USD", "1"),
      priced(null, "USD", "2"),
      priced("30.00", "USD", "3"),
    ]);

    assert.equal(distribution.pricedCount, 2);
    assert.equal(distribution.unpricedCount, 1);
    assert.equal(distribution.min, "10.00");
    assert.equal(distribution.max, "30.00");
  });

  it("refuses statistics rather than averaging across mixed currencies", () => {
    const distribution = computePriceDistribution([
      priced("10.00", "USD", "1"),
      priced("20.00", "EUR", "2"),
    ]);

    assert.equal(distribution.currency, null);
    assert.equal(distribution.mixedCurrencies, true);
    assert.deepEqual(distribution.currencies, ["USD", "EUR"]);
    assert.equal(distribution.min, null);
    assert.equal(distribution.max, null);
    assert.equal(distribution.median, null);
    assert.equal(distribution.mean, null);
    assert.ok(distribution.limitation?.includes("USD, EUR"));
  });

  it("reports a limitation when nothing in the sample carried a price", () => {
    const distribution = computePriceDistribution([priced(null, "USD", "1")]);

    assert.equal(distribution.pricedCount, 0);
    assert.equal(distribution.unpricedCount, 1);
    assert.equal(distribution.median, null);
    assert.ok(distribution.limitation !== null);
  });

  it("handles an empty sample", () => {
    const distribution = computePriceDistribution([]);

    assert.equal(distribution.pricedCount, 0);
    assert.equal(distribution.unpricedCount, 0);
    assert.deepEqual(distribution.currencies, []);
    assert.equal(distribution.median, null);
  });
});

describe("priceSpreadRatio", () => {
  it("is the max over the min, as a ratio", () => {
    const distribution = computePriceDistribution([
      priced("10.00", "USD", "1"),
      priced("40.00", "USD", "2"),
    ]);
    assert.equal(priceSpreadRatio(distribution), 4);
  });

  it("is null when no spread is computable", () => {
    assert.equal(priceSpreadRatio(computePriceDistribution([])), null);
  });

  it("is null when the floor is zero, which is not a real spread", () => {
    const distribution = computePriceDistribution([
      priced("0.00", "USD", "1"),
      priced("40.00", "USD", "2"),
    ]);
    assert.equal(priceSpreadRatio(distribution), null);
  });
});
