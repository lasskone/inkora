/**
 * Unit tests for the deterministic sorting and filtering of a seller sample.
 *
 * Every ordering has a fully deterministic tie-break ladder, and re-sorting
 * costs zero upstream calls, so the tests pin both the orderings and the
 * ladder. See `src/lib/sellers/sorting.ts`.
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { SellerListing } from "./types";
import {
  SELLER_SORT_KEYS,
  distinctCategories,
  distinctConditions,
  filterSellerListings,
  isValidSortKey,
  sortSellerListings,
} from "./sorting";

function sample(args: {
  externalId: string;
  price?: string | null;
  title?: string;
  condition?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  created?: string | null;
}): SellerListing {
  return {
    marketplace: "ebay",
    externalId: args.externalId,
    title: args.title ?? `Title ${args.externalId}`,
    imageUrl: null,
    listingUrl: null,
    price: args.price === undefined ? "10.00" : args.price,
    currency: args.price === null ? null : "USD",
    condition: args.condition ?? null,
    conditionId: null,
    sellerName: "inkora-store",
    sellerFeedbackPercentage: null,
    sellerFeedbackScore: null,
    shippingCost: null,
    shippingCurrency: null,
    location: null,
    primaryCategoryId: args.categoryId ?? null,
    primaryCategoryName: args.categoryName ?? null,
    categories: [],
    buyingOptions: [],
    itemCreationDate: args.created ?? null,
    itemEndDate: null,
    epid: null,
    provenance: "OBSERVED",
    fetchedAt: "2026-01-01T00:00:00Z",
  };
}

const UNPRICED = [sample({ externalId: "u", price: null, title: "Unpriced" })];
const THREE = [
  sample({ externalId: "c", price: "30.00", title: "Gamma" }),
  sample({ externalId: "a", price: "10.00", title: "Alpha" }),
  sample({ externalId: "b", price: "20.00", title: "Beta" }),
];

describe("isValidSortKey", () => {
  it("accepts every key the boundary knows", () => {
    for (const key of SELLER_SORT_KEYS) {
      assert.equal(isValidSortKey(key), true);
    }
  });

  it("refuses an unknown key rather than ignoring it", () => {
    assert.equal(isValidSortKey("opportunity-score"), false);
    assert.equal(isValidSortKey(""), false);
  });
});

describe("sortSellerListings", () => {
  it("never mutates the input array", () => {
    const input = [...THREE];
    sortSellerListings(input, "price-asc");
    assert.deepEqual(
      input.map((listing) => listing.externalId),
      ["c", "a", "b"],
    );
  });

  it("orders by price ascending with unpriced listings last", () => {
    const sorted = sortSellerListings([...THREE, ...UNPRICED], "price-asc");
    assert.deepEqual(
      sorted.map((listing) => listing.externalId),
      ["a", "b", "c", "u"],
    );
  });

  it("orders by price descending with unpriced listings still last", () => {
    const sorted = sortSellerListings([...THREE, ...UNPRICED], "price-desc");
    assert.deepEqual(
      sorted.map((listing) => listing.externalId),
      ["c", "b", "a", "u"],
    );
  });

  it("breaks a price tie on the external id, ascending", () => {
    const sorted = sortSellerListings(
      [
        sample({ externalId: "z", price: "10.00" }),
        sample({ externalId: "a", price: "10.00" }),
      ],
      "price-asc",
    );
    assert.deepEqual(
      sorted.map((listing) => listing.externalId),
      ["a", "z"],
    );
  });

  it("orders newest first under recent, with undated listings last", () => {
    const sorted = sortSellerListings(
      [
        sample({ externalId: "old", created: "2026-01-01T00:00:00Z" }),
        sample({ externalId: "undated", created: null }),
        sample({ externalId: "new", created: "2026-02-01T00:00:00Z" }),
      ],
      "recent",
    );
    assert.deepEqual(
      sorted.map((listing) => listing.externalId),
      ["new", "old", "undated"],
    );
  });

  it("orders alphabetically by title", () => {
    const sorted = sortSellerListings(THREE, "title");
    assert.deepEqual(
      sorted.map((listing) => listing.externalId),
      ["a", "b", "c"],
    );
  });

  it("orders by category name and leaves uncategorized last", () => {
    const sorted = sortSellerListings(
      [
        sample({ externalId: "z", categoryId: "1", categoryName: "Toys" }),
        sample({ externalId: "b", categoryId: null, categoryName: null }),
        sample({ externalId: "a", categoryId: "2", categoryName: "Audio" }),
      ],
      "category",
    );
    assert.deepEqual(
      sorted.map((listing) => listing.externalId),
      ["a", "z", "b"],
    );
  });

  it("orders by condition and leaves unspecified last", () => {
    const sorted = sortSellerListings(
      [
        sample({ externalId: "b", condition: null }),
        sample({ externalId: "a", condition: "New" }),
      ],
      "condition",
    );
    assert.deepEqual(
      sorted.map((listing) => listing.externalId),
      ["a", "b"],
    );
  });
});

describe("filterSellerListings", () => {
  it("passes everything through when no filter is given", () => {
    assert.equal(filterSellerListings(THREE, {}).length, 3);
  });

  it("keeps only the requested category", () => {
    const filtered = filterSellerListings(
      [
        sample({ externalId: "a", categoryId: "audio" }),
        sample({ externalId: "b", categoryId: "toys" }),
      ],
      { categoryId: "audio" },
    );
    assert.deepEqual(
      filtered.map((listing) => listing.externalId),
      ["a"],
    );
  });

  it("matches the condition case insensitively", () => {
    const filtered = filterSellerListings(
      [
        sample({ externalId: "a", condition: "New" }),
        sample({ externalId: "b", condition: "Used" }),
      ],
      { condition: "new" },
    );
    assert.deepEqual(
      filtered.map((listing) => listing.externalId),
      ["a"],
    );
  });

  it("keeps a listing priced at or above a minimum", () => {
    const filtered = filterSellerListings(THREE, { minPriceCents: 2000 });
    assert.deepEqual(
      filtered.map((listing) => listing.externalId),
      ["c", "b"],
    );
  });

  it("keeps a listing priced at or below a maximum", () => {
    const filtered = filterSellerListings(THREE, { maxPriceCents: 2000 });
    assert.deepEqual(
      filtered.map((listing) => listing.externalId),
      ["a", "b"],
    );
  });

  it("never includes an unpriced listing in a price range", () => {
    const filtered = filterSellerListings([...THREE, ...UNPRICED], {
      minPriceCents: 0,
    });
    assert.equal(filtered.length, 3);
  });
});

describe("distinctConditions", () => {
  it("returns sorted, deduplicated condition values", () => {
    const conditions = distinctConditions([
      sample({ externalId: "1", condition: "Used" }),
      sample({ externalId: "2", condition: "New" }),
      sample({ externalId: "3", condition: "Used" }),
      sample({ externalId: "4", condition: null }),
    ]);
    assert.deepEqual(conditions, ["New", "Used"]);
  });
});

describe("distinctCategories", () => {
  it("returns categories sorted by name", () => {
    const categories = distinctCategories([
      sample({ externalId: "1", categoryId: "1", categoryName: "Toys" }),
      sample({ externalId: "2", categoryId: "2", categoryName: "Audio" }),
    ]);
    assert.deepEqual(categories, [
      { categoryId: "2", categoryName: "Audio" },
      { categoryId: "1", categoryName: "Toys" },
    ]);
  });

  it("falls back to the category id when no name is present", () => {
    const categories = distinctCategories([
      sample({ externalId: "1", categoryId: "26395", categoryName: null }),
    ]);
    assert.deepEqual(categories, [{ categoryId: "26395", categoryName: "26395" }]);
  });

  it("keeps the first name it saw for a repeated category", () => {
    const categories = distinctCategories([
      sample({ externalId: "1", categoryId: "1", categoryName: "Audio" }),
      sample({ externalId: "2", categoryId: "1", categoryName: null }),
    ]);
    assert.deepEqual(categories, [{ categoryId: "1", categoryName: "Audio" }]);
  });
});
