/**
 * Unit tests for the category intelligence over a bounded seller sample.
 *
 * The denominator is always the listings that carried a category, so the shares
 * describe the classifiable part of the sample, and the limitation is attached
 * to every result. See `src/lib/sellers/categories.ts`.
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { SellerListing } from "./types";
import { computeCategoryIntelligence, shareOf } from "./categories";

function categorized(
  externalId: string,
  categoryId: string | null,
  categoryName: string | null,
): SellerListing {
  return {
    marketplace: "ebay",
    externalId,
    title: `Listing ${externalId}`,
    imageUrl: null,
    listingUrl: null,
    price: null,
    currency: null,
    condition: null,
    conditionId: null,
    sellerName: "inkora-store",
    sellerFeedbackPercentage: null,
    sellerFeedbackScore: null,
    shippingCost: null,
    shippingCurrency: null,
    location: null,
    primaryCategoryId: categoryId,
    primaryCategoryName: categoryName,
    categories: [],
    buyingOptions: [],
    itemCreationDate: null,
    itemEndDate: null,
    epid: null,
    provenance: "OBSERVED",
    fetchedAt: "2026-01-01T00:00:00Z",
  };
}

describe("shareOf", () => {
  it("expresses the count as a percent of the classifiable denominator", () => {
    assert.equal(shareOf(1, 3), 33.33);
    assert.equal(shareOf(2, 3), 66.67);
    assert.equal(shareOf(4, 4), 100);
  });

  it("is zero when there is no denominator", () => {
    assert.equal(shareOf(1, 0), 0);
  });
});

describe("computeCategoryIntelligence", () => {
  it("orders the breakdown by count and reports shares of the classifiable part", () => {
    const intelligence = computeCategoryIntelligence([
      categorized("1", "audio", "Audio"),
      categorized("2", "audio", "Audio"),
      categorized("3", "audio", "Audio"),
      categorized("4", "toys", "Toys"),
    ]);

    assert.equal(intelligence.distinctCategoryCount, 2);
    assert.equal(intelligence.sampledListingCount, 4);
    assert.equal(intelligence.categories.length, 2);
    assert.equal(intelligence.categories[0].categoryId, "audio");
    assert.equal(intelligence.categories[0].listingCount, 3);
    assert.equal(intelligence.categories[0].sharePercent, 75);
    assert.equal(intelligence.categories[1].sharePercent, 25);
    assert.equal(intelligence.dominantCategory?.categoryId, "audio");
  });

  it("breaks a count tie on the category id, so the order is reproducible", () => {
    const intelligence = computeCategoryIntelligence([
      categorized("z", "toys", "Toys"),
      categorized("a", "audio", "Audio"),
    ]);
    assert.equal(intelligence.categories[0].categoryId, "audio");
    assert.equal(intelligence.categories[1].categoryId, "toys");
  });

  it("falls back to the category id when the marketplace sends no name", () => {
    const intelligence = computeCategoryIntelligence([
      categorized("1", "26395", null),
    ]);
    assert.equal(intelligence.categories[0].categoryName, "26395");
  });

  it("excludes uncategorized listings from the shares and says so", () => {
    const intelligence = computeCategoryIntelligence([
      categorized("1", "audio", "Audio"),
      categorized("2", null, null),
    ]);

    assert.equal(intelligence.distinctCategoryCount, 1);
    assert.equal(intelligence.categories[0].sharePercent, 100);
    assert.ok(
      intelligence.limitation.includes(
        "1 of 2 sampled listings carried no category",
      ),
    );
  });

  it("keeps the dominant category null when nothing was classifiable", () => {
    const intelligence = computeCategoryIntelligence([
      categorized("1", null, null),
      categorized("2", null, null),
    ]);

    assert.equal(intelligence.dominantCategory, null);
    assert.equal(intelligence.distinctCategoryCount, 0);
    assert.ok(
      intelligence.limitation.includes(
        "2 of 2 sampled listings carried no category",
      ),
    );
  });

  it("always states that a sample is not a complete inventory read", () => {
    const intelligence = computeCategoryIntelligence([]);
    assert.ok(intelligence.limitation.includes("observed sample only"));
    assert.equal(intelligence.dominantCategory, null);
  });
});
