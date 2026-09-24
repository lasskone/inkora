/**
 * Unit tests for the pure seller normalization helpers.
 *
 * These cover the two guarantees the scanner rests on: a user-typed handle
 * becomes one canonical history key, and a seller profile is derived only from
 * what the scan actually observed. See `src/lib/sellers/normalize.ts`.
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { SellerListing } from "./types";
import {
  consensusSellerBlock,
  deriveSellerProfile,
  normalizeSellerHandle,
  sampleBelongsToSeller,
  sellerIdentity,
} from "./normalize";

/** Minimal listing factory: only the fields the normalization helpers read. */
function listing(args: {
  externalId: string;
  sellerName?: string | null;
  feedbackScore?: number | null;
  feedbackPercentage?: number | null;
}): SellerListing {
  return {
    marketplace: "ebay",
    externalId: args.externalId,
    title: `Listing ${args.externalId}`,
    imageUrl: null,
    listingUrl: null,
    price: "19.99",
    currency: "USD",
    condition: "New",
    conditionId: null,
    sellerName: args.sellerName === undefined ? "inkora-store" : args.sellerName,
    sellerFeedbackPercentage: args.feedbackPercentage ?? 99.5,
    sellerFeedbackScore: args.feedbackScore ?? 1234,
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

describe("normalizeSellerHandle", () => {
  it("trims surrounding whitespace and lowercases", () => {
    assert.equal(normalizeSellerHandle("  Inkora-Store "), "inkora-store");
  });

  it("refuses a handle that contains a space or other separator", () => {
    assert.equal(normalizeSellerHandle("Inkora Store"), null);
    assert.equal(normalizeSellerHandle("inkora/store"), null);
  });

  it("accepts the separators a real handle may contain", () => {
    assert.equal(normalizeSellerHandle("My_Store-1.x"), "my_store-1.x");
  });

  it("refuses a leading separator, since a handle starts with a letter or digit", () => {
    assert.equal(normalizeSellerHandle("-nope"), null);
  });

  it("refuses characters outside the allowlist instead of escaping them", () => {
    assert.equal(normalizeSellerHandle("bad handle!"), null);
    assert.equal(normalizeSellerHandle("user@example"), null);
  });

  it("refuses an empty handle", () => {
    assert.equal(normalizeSellerHandle(""), null);
    assert.equal(normalizeSellerHandle("   "), null);
  });

  it("refuses a handle longer than the documented bound", () => {
    assert.equal(normalizeSellerHandle("a".repeat(65)), null);
    assert.equal(normalizeSellerHandle("a".repeat(64)), "a".repeat(64));
  });
});

describe("sellerIdentity", () => {
  it("carries the normalized handle as the stable external id", () => {
    const identity = sellerIdentity("ebay", "inkora-store", "Inkora Store");
    assert.deepEqual(identity, {
      marketplace: "ebay",
      externalSellerId: "inkora-store",
      username: "Inkora Store",
    });
  });
});

describe("consensusSellerBlock", () => {
  it("reports nothing when the sample is empty", () => {
    assert.deepEqual(consensusSellerBlock([]), {
      username: null,
      feedbackScore: null,
      feedbackPercentage: null,
    });
  });

  it("returns the seller block every observed listing agrees on", () => {
    assert.deepEqual(
      consensusSellerBlock([
        listing({ externalId: "1" }),
        listing({ externalId: "2" }),
      ]),
      { username: "inkora-store", feedbackScore: 1234, feedbackPercentage: 99.5 },
    );
  });

  it("refuses to summarize a sample that disagrees about the seller", () => {
    assert.deepEqual(
      consensusSellerBlock([
        listing({ externalId: "1", sellerName: "seller-a" }),
        listing({ externalId: "2", sellerName: "seller-b" }),
      ]),
      { username: null, feedbackScore: null, feedbackPercentage: null },
    );
  });

  it("keeps the username but reports divergent feedback as unresolvable", () => {
    assert.deepEqual(
      consensusSellerBlock([
        listing({ externalId: "1", feedbackScore: 100 }),
        listing({ externalId: "2", feedbackScore: 200 }),
      ]),
      { username: "inkora-store", feedbackScore: null, feedbackPercentage: 99.5 },
    );
  });
});

describe("deriveSellerProfile", () => {
  it("derives feedback from the listings and marks it official", () => {
    const profile = deriveSellerProfile({
      marketplace: "ebay",
      normalizedHandle: "inkora-store",
      listings: [listing({ externalId: "1" }), listing({ externalId: "2" })],
      observedListingCount: 240,
      observedAt: "2026-01-01T00:00:00Z",
    });

    assert.equal(profile.externalSellerId, "inkora-store");
    assert.equal(profile.username, "inkora-store");
    assert.equal(profile.feedbackScore, 1234);
    assert.equal(profile.feedbackPercentage, 99.5);
    assert.equal(profile.observedListingCount, 240);
    assert.equal(profile.sampledListingCount, 2);
    assert.equal(profile.provenance.feedback, "OFFICIAL");
    assert.equal(profile.provenance.counts, "OBSERVED");
    assert.equal(profile.observedAt, "2026-01-01T00:00:00Z");
  });

  it("invents no figure for a seller the search could not observe", () => {
    const profile = deriveSellerProfile({
      marketplace: "ebay",
      normalizedHandle: "ghost-store",
      listings: [],
      observedListingCount: 0,
      observedAt: "2026-01-01T00:00:00Z",
    });

    assert.equal(profile.username, null);
    assert.equal(profile.feedbackScore, null);
    assert.equal(profile.feedbackPercentage, null);
    assert.equal(profile.sampledListingCount, 0);
  });
});

describe("sampleBelongsToSeller", () => {
  it("accepts an empty sample, which carries no contradiction", () => {
    assert.equal(sampleBelongsToSeller([], "inkora-store"), true);
  });

  it("is true when every listing belongs to the normalized handle", () => {
    const listings = [
      listing({ externalId: "1", sellerName: "Inkora-Store" }),
      listing({ externalId: "2", sellerName: "inkora-store" }),
    ];
    assert.equal(sampleBelongsToSeller(listings, "inkora-store"), true);
  });

  it("is false the moment one listing belongs to someone else", () => {
    const listings = [
      listing({ externalId: "1", sellerName: "inkora-store" }),
      listing({ externalId: "2", sellerName: "someone-else" }),
    ];
    assert.equal(sampleBelongsToSeller(listings, "inkora-store"), false);
  });

  it("is false when the marketplace returned no seller identifier at all", () => {
    const listings = [listing({ externalId: "1", sellerName: null })];
    assert.equal(sampleBelongsToSeller(listings, "inkora-store"), false);
  });
});
