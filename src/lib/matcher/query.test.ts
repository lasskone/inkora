import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_QUERIES,
  MAX_QUERY_LENGTH,
  generateCandidateQueries,
} from "@/lib/matcher/query";
import type { MarketplaceProduct } from "@/lib/marketplace/types";

function makeMarketplace(title: string): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: "v1|123",
    title,
    imageUrl: null,
    listingUrl: null,
    price: "29.99",
    currency: "USD",
    condition: "NEW",
    sellerName: null,
    sellerFeedbackPercentage: null,
    shippingCost: null,
    shippingCurrency: null,
    location: null,
    provenance: "OFFICIAL",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("query generation is bounded and deduplicated", () => {
  const queries = generateCandidateQueries(
    makeMarketplace("Anker Soundcore Life Q30 Wireless Headphones Black"),
  );
  assert.ok(queries.length <= MAX_QUERIES);
  const texts = queries.map((entry) => entry.query);
  assert.equal(new Set(texts).size, texts.length, "queries must be unique");
  for (const entry of queries) {
    assert.ok(entry.query.length <= MAX_QUERY_LENGTH);
    assert.ok(entry.rationale.length > 0);
  }
});

test("a generic product yields fewer, broader queries", () => {
  const queries = generateCandidateQueries(
    makeMarketplace("Wireless Earbuds Bluetooth Headphones"),
  );
  const cleaned = queries.find((entry) => entry.query.includes("wireless"));
  assert.ok(cleaned, "the cleaned-title query must be generated");
  // No identifiers or specs exist, so no needle-in-haystack query is emitted.
  assert.ok(
    !queries.some((entry) => entry.rationale.includes("needle")),
    "no identifier query for a generic product",
  );
});

test("a modelled product generates an identifier-focused query", () => {
  const queries = generateCandidateQueries(
    makeMarketplace("Sony WH-1000XM5 Wireless Noise Cancelling Headphones"),
  );
  assert.ok(
    queries.some((entry) => entry.rationale.includes("needle")),
    "an identifier-focused query must be generated",
  );
  assert.ok(
    queries.some((entry) => entry.query.includes("wh1000xm5")),
    "the identifier query must carry the compact model token",
  );
});

test("boilerplate is stripped from generated queries", () => {
  const queries = generateCandidateQueries(
    makeMarketplace("Wireless Earbuds FREE Shipping Hot Sale"),
  );
  for (const entry of queries) {
    assert.ok(!/free shipping|hot sale/.test(entry.query));
  }
});

test("a title with no usable text yields no queries", () => {
  assert.deepEqual(generateCandidateQueries(makeMarketplace("   ")), []);
});
