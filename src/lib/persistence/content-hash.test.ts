import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalJson,
  digestJson,
  hashEconomicsObservation,
  hashMarketplaceSnapshot,
  hashMatchObservation,
} from "@/lib/persistence/content-hash";

/**
 * The content hash *is* the deduplication verdict: identical hashes mean "reuse
 * the latest observation", differing hashes mean "append a new one". Pinning
 * determinism here is what keeps the observation tables from growing without
 * bound while a listing is scanned repeatedly (docs/DATABASE.md §7).
 */

const MARKETPLACE_SNAPSHOT = {
  title: "Ink cartridge, black",
  imageUrl: "https://example.example/img.jpg",
  listingUrl: "https://example.example/item/1",
  priceCents: 2999,
  currency: "USD",
  condition: "New",
  sellerIdentifier: "seller-42",
  sellerFeedbackPercentage: 98.1,
  buyerShippingCents: 0,
  shippingCurrency: "USD",
  location: "US",
  provenance: "OFFICIAL",
} as const;

const ECONOMICS_OBSERVATION = {
  feeEngineVersion: "ebay-fee-rules-1.0",
  economicsEngineVersion: "economics-landed-1.0",
  completeness: "COMPLETE",
  itemPriceCents: 2999,
  buyerShippingCents: 0,
  grossMarketplaceRevenueCents: 2999,
  currency: "USD",
  supplierProductCostCents: 1200,
  supplierCostBasis: "SELECTED_VARIANT",
  supplierShippingCents: 549,
  supplierShippingMethod: "CJPacket",
  landedCostCents: 1749,
  marketplaceFeeCents: 358,
  estimatedProfitCents: 892,
  marginPercentCents: 2974,
  shippingDestination: { countryCode: "US", postalCode: "90210", label: "baseline" },
} as const;

test("canonical JSON sorts object keys so key order never changes the hash", () => {
  assert.equal(
    canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } }),
    canonicalJson({ a: 2, c: { y: 2, z: 1 }, b: 1 }),
  );
});

test("canonical JSON treats an omitted field the same as an explicitly null one", () => {
  // A field the provider omitted and a field it returned empty are the same
  // observation — that is what lets a missing value dedup against a null.
  assert.equal(canonicalJson({ price: null }), canonicalJson({ price: undefined }));
});

test("canonical JSON keeps array order, because signals and quotes are ordered", () => {
  assert.notEqual(
    canonicalJson({ items: ["a", "b"] }),
    canonicalJson({ items: ["b", "a"] }),
  );
});

test("digestJson is deterministic for identical content", () => {
  assert.equal(
    digestJson({ price: 2999, title: "x" }),
    digestJson({ title: "x", price: 2999 }),
  );
  assert.equal(digestJson(MARKETPLACE_SNAPSHOT), digestJson(MARKETPLACE_SNAPSHOT));
});

test("digestJson produces a 64-character sha256 hex digest", () => {
  assert.match(digestJson({ a: 1 }), /^[0-9a-f]{64}$/);
});


test("hashMarketplaceSnapshot is stable, and any meaningful change is a new observation", () => {
  const baseline = hashMarketplaceSnapshot(MARKETPLACE_SNAPSHOT);

  // Identical observation in different memory: same verdict.
  assert.equal(hashMarketplaceSnapshot({ ...MARKETPLACE_SNAPSHOT }), baseline);

  assert.notEqual(
    hashMarketplaceSnapshot({ ...MARKETPLACE_SNAPSHOT, priceCents: 3099 }),
    baseline,
  );
  assert.notEqual(
    hashMarketplaceSnapshot({ ...MARKETPLACE_SNAPSHOT, title: "Renamed listing" }),
    baseline,
  );
  assert.notEqual(
    hashMarketplaceSnapshot({ ...MARKETPLACE_SNAPSHOT, buyerShippingCents: 499 }),
    baseline,
  );
  assert.notEqual(
    hashMarketplaceSnapshot({ ...MARKETPLACE_SNAPSHOT, provenance: "ESTIMATED" }),
    baseline,
  );
});

test("hashEconomicsObservation stays stable across repeated identical evaluations", () => {
  const baseline = hashEconomicsObservation(ECONOMICS_OBSERVATION);

  assert.equal(hashEconomicsObservation({ ...ECONOMICS_OBSERVATION }), baseline);

  // A real profit change is a new observation, including a loss.
  assert.notEqual(
    hashEconomicsObservation({
      ...ECONOMICS_OBSERVATION,
      estimatedProfitCents: -500,
    }),
    baseline,
  );
  // A margin change is a new observation.
  assert.notEqual(
    hashEconomicsObservation({
      ...ECONOMICS_OBSERVATION,
      marginPercentCents: 1000,
    }),
    baseline,
  );
  // A new fee-rule version is a different calculation and must be recorded.
  assert.notEqual(
    hashEconomicsObservation({
      ...ECONOMICS_OBSERVATION,
      feeEngineVersion: "ebay-fee-rules-1.1",
    }),
    baseline,
  );
  // A completeness downgrade (the variant stopped resolving) is new.
  assert.notEqual(
    hashEconomicsObservation({
      ...ECONOMICS_OBSERVATION,
      completeness: "PARTIAL",
      supplierCostBasis: "CATALOG_MINIMUM",
    }),
    baseline,
  );
  // A different destination is a different calculation.
  assert.notEqual(
    hashEconomicsObservation({
      ...ECONOMICS_OBSERVATION,
      shippingDestination: { countryCode: "CA", postalCode: "M5V", label: "CA" },
    }),
    baseline,
  );
});

test("hashMatchObservation reacts to the verdict, not to unobserved metadata", () => {
  const signals = [{ name: "distinctiveTokenAgreement", contribution: 40 }];
  const contradictions = [{ name: "modelNumberMismatch", severity: "hard", cap: 0 }];

  const baseline = hashMatchObservation({
    matcherVersion: "matcher-text-1.0",
    confidence: 72,
    confidenceBand: "MEDIUM",
    signals,
    contradictions,
  });

  assert.equal(
    hashMatchObservation({
      matcherVersion: "matcher-text-1.0",
      confidence: 72,
      confidenceBand: "MEDIUM",
      signals,
      contradictions,
    }),
    baseline,
  );

  // A re-ranked candidate is a new match observation.
  assert.notEqual(
    hashMatchObservation({
      matcherVersion: "matcher-text-1.0",
      confidence: 81,
      confidenceBand: "HIGH",
      signals,
      contradictions,
    }),
    baseline,
  );

  // A matcher upgrade is a new match observation.
  assert.notEqual(
    hashMatchObservation({
      matcherVersion: "matcher-text-1.1",
      confidence: 72,
      confidenceBand: "MEDIUM",
      signals,
      contradictions,
    }),
    baseline,
  );
});
