/**
 * Unit tests for the product concentration over a bounded seller sample.
 *
 * Concentration measures repetition in what a seller *lists*; the tests pin the
 * counts, the share arithmetic and the auditable breadth thresholds, and never
 * treat a repeated title as units sold. See `src/lib/sellers/concentration.ts`.
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { SellerListing } from "./types";
import { classifyBreadth, computeProductConcentration } from "./concentration";

function titled(externalId: string, title: string): SellerListing {
  return {
    marketplace: "ebay",
    externalId,
    title,
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

const XM5 = "Sony WH-1000XM5 Headphones";

describe("classifyBreadth", () => {
  it("calls a signal-free sample narrow rather than undefined", () => {
    assert.equal(classifyBreadth(0, 0), "narrow");
    assert.equal(classifyBreadth(0, 5), "narrow");
  });

  it("classifies one or two families as narrow", () => {
    assert.equal(classifyBreadth(1, 10), "narrow");
    assert.equal(classifyBreadth(2, 10), "narrow");
  });

  it("classifies the middle range as mixed", () => {
    assert.equal(classifyBreadth(3, 10), "mixed");
    assert.equal(classifyBreadth(5, 10), "mixed");
  });

  it("classifies six or more families as broad", () => {
    assert.equal(classifyBreadth(6, 10), "broad");
    assert.equal(classifyBreadth(20, 10), "broad");
  });
});

describe("computeProductConcentration", () => {
  it("groups listings into families by the title fingerprint", () => {
    const concentration = computeProductConcentration([
      titled("1", XM5),
      titled("2", XM5),
      titled("3", "Anker Soundcore Earbuds"),
      titled("4", "Apple AirPods Pro"),
    ]);

    assert.equal(concentration.distinctTitleFamilies, 3);
    assert.equal(concentration.maxFamilyCount, 2);
    assert.equal(concentration.topFamilySharePercent, 50);
    assert.equal(concentration.sampledListingCount, 4);
    assert.equal(concentration.catalogBreadth, "mixed");
  });

  it("reports repeated families with the listing's own title, most repeated first", () => {
    const concentration = computeProductConcentration([
      titled("1", XM5),
      titled("2", XM5),
      titled("3", XM5),
    ]);

    assert.equal(concentration.repeatedFamilies.length, 1);
    assert.equal(concentration.repeatedFamilies[0].sampleTitle, XM5);
    assert.equal(concentration.repeatedFamilies[0].listingCount, 3);
    assert.equal(concentration.maxFamilyCount, 3);
    assert.equal(concentration.topFamilySharePercent, 100);
    assert.equal(concentration.catalogBreadth, "narrow");
  });

  it("is order invariant for the family counts", () => {
    const reversed = computeProductConcentration([
      titled("4", "Apple AirPods Pro"),
      titled("3", "Anker Soundcore Earbuds"),
      titled("2", XM5),
      titled("1", XM5),
    ]);
    assert.equal(reversed.distinctTitleFamilies, 3);
    assert.equal(reversed.maxFamilyCount, 2);
  });

  it("reports no family when no title carries signal", () => {
    const concentration = computeProductConcentration([
      titled("1", "!!!"),
      titled("2", "???"),
    ]);

    assert.equal(concentration.distinctTitleFamilies, 0);
    assert.equal(concentration.maxFamilyCount, 0);
    assert.equal(concentration.topFamilySharePercent, 0);
    assert.equal(concentration.repeatedFamilies.length, 0);
    assert.equal(concentration.catalogBreadth, "narrow");
  });

  it("caps the repeated-family rows at the documented bound", () => {
    const listings: SellerListing[] = [];
    for (let index = 0; index < 12; index += 1) {
      const title = `Model M${index} Earbuds`;
      listings.push(titled(`a${index}`, title));
      listings.push(titled(`b${index}`, title));
    }

    const concentration = computeProductConcentration(listings);
    assert.equal(concentration.distinctTitleFamilies, 12);
    assert.equal(concentration.repeatedFamilies.length, 10);
    assert.equal(concentration.catalogBreadth, "broad");
  });

  it("always states that concentration is a sample measurement, not sales", () => {
    const concentration = computeProductConcentration([titled("1", XM5)]);
    assert.ok(concentration.limitation.includes("observed sample only"));
    assert.ok(concentration.limitation.includes("listings rather than sales"));
  });
});
