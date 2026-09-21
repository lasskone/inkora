import { test } from "node:test";
import assert from "node:assert/strict";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { SupplierProduct } from "@/lib/supplier/types";
import { scoreCandidate } from "@/lib/matcher/scoring";

/**
 * The scoring function only ever reads the two titles, so the fixtures vary the
 * optional fields deliberately — proving missing/null fields never change the
 * verdict and that price is never identity evidence.
 */

export function makeMarketplace(
  title: string,
  overrides: Partial<MarketplaceProduct> = {},
): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: "v1|1234567890",
    title,
    imageUrl: "https://example.com/ebay.jpg",
    listingUrl: "https://example.com/ebay/1234567890",
    price: "29.99",
    currency: "USD",
    condition: "NEW",
    sellerName: "seller-one",
    sellerFeedbackPercentage: 98.7,
    shippingCost: "0.00",
    shippingCurrency: "USD",
    location: "Austin, US",
    provenance: "OFFICIAL",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeSupplier(
  title: string,
  overrides: Partial<SupplierProduct> = {},
): SupplierProduct {
  return {
    supplier: "cj",
    externalId: "cj-product-1",
    sku: "CJ-SKU-1",
    title,
    imageUrl: "https://example.com/cj.jpg",
    productUrl: null,
    category: null,
    supplierPrice: "12.50",
    currency: "USD",
    availableInventory: null,
    warehouseCountry: null,
    shippingOrigin: null,
    variants: [],
    provenance: "OFFICIAL",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("nearly identical titles with a model number rate HIGH", () => {
  const result = scoreCandidate(
    makeMarketplace("Soundcore Life Q30 Hybrid Active Noise Cancelling Headphones"),
    makeSupplier("Soundcore Life Q30 Hybrid Active Noise Cancelling Headphones"),
  );
  assert.equal(result.confidenceBand, "HIGH");
  assert.ok(result.confidence >= 70, `expected >= 70, got ${result.confidence}`);
  assert.ok(result.explanation.length > 0);
});

test("reordered tokens score identically to the original order", () => {
  const ordered = scoreCandidate(
    makeMarketplace("Anker Soundcore Life Q30 Wireless Headphones Black"),
    makeSupplier("Anker Soundcore Life Q30 Wireless Headphones Black"),
  );
  const reordered = scoreCandidate(
    makeMarketplace("Anker Soundcore Life Q30 Wireless Headphones Black"),
    makeSupplier("Black Wireless Headphones Life Q30 Soundcore Anker"),
  );
  // Token order never influences the score — only the token sets do.
  assert.equal(reordered.confidence, ordered.confidence);
  assert.equal(reordered.confidenceBand, ordered.confidenceBand);
  // MEDIUM rather than HIGH here is deliberate: the title names two known
  // brands (anker + soundcore), so the brand is ambiguous and contributes
  // nothing. HIGH requires title agreement *plus* corroborating evidence.
  assert.equal(ordered.confidenceBand, "MEDIUM");
});

test("generic keyword overlap cannot escape LOW confidence", () => {
  const result = scoreCandidate(
    makeMarketplace("Wireless Earbuds Bluetooth Headphones"),
    makeSupplier("Wireless Earbuds with LED Light Bluetooth Headphones Display Case"),
  );
  assert.equal(result.confidenceBand, "LOW");
  assert.ok(result.confidence < 45, `expected < 45, got ${result.confidence}`);
  assert.ok(
    result.signals.every((signal) => signal.name !== "distinctiveTokenAgreement"),
    "generic overlap must not produce distinctive-token agreement",
  );
});

test("identical generic titles cap at MEDIUM without corroborating evidence", () => {
  const result = scoreCandidate(
    makeMarketplace("Wireless Earbuds Bluetooth Headphones"),
    makeSupplier("Wireless Earbuds Bluetooth Headphones"),
  );
  // Perfect title agreement alone tops out at MEDIUM: reaching HIGH requires a
  // corroborating identity signal (model, specification, or unambiguous brand).
  assert.equal(result.confidenceBand, "MEDIUM");
  assert.ok(result.confidence < 70);
});

test("a shared model number raises confidence above pure token similarity", () => {
  const withModel = scoreCandidate(
    makeMarketplace("Anker Soundcore Life Q30 Wireless Headphones"),
    makeSupplier("Life Q30 ANC Headphones Over-Ear"),
  );
  const withoutModel = scoreCandidate(
    makeMarketplace("Anker Soundcore Life Wireless Headphones"),
    makeSupplier("Life ANC Headphones Over-Ear"),
  );
  assert.ok(withModel.confidence > withoutModel.confidence);
  assert.ok(
    withModel.signals.some((signal) => signal.name === "distinctiveTokenAgreement"),
  );
});


test("conflicting model numbers cap confidence hard", () => {
  const result = scoreCandidate(
    makeMarketplace("Sony WH-1000XM5 Wireless Noise Cancelling Headphones"),
    makeSupplier("Sony WH-1000XM4 Wireless Noise Cancelling Headphones"),
  );
  assert.equal(result.confidenceBand, "LOW");
  assert.ok(result.confidence <= 25, `expected <= 25, got ${result.confidence}`);
  const conflict = result.contradictions.find(
    (entry) => entry.name === "modelConflict",
  );
  assert.ok(conflict, "a model conflict must be recorded");
  assert.equal(conflict?.severity, "hard");
  assert.equal(conflict?.cap, 25);
});

test("matching capacity contributes a specification signal", () => {
  const result = scoreCandidate(
    makeMarketplace("Insulated Water Bottle 500ml Stainless Steel"),
    makeSupplier("Vacuum Insulated Water Bottle 500 ml Stainless Steel Tumbler"),
  );
  assert.ok(
    result.signals.some((signal) => signal.name === "unitAgreement"),
    "matching capacity must register a unitAgreement signal",
  );
  assert.ok(result.confidence > 30);
});

test("conflicting capacity caps confidence despite matching words", () => {
  const result = scoreCandidate(
    makeMarketplace("Insulated Water Bottle 500ml Stainless Steel"),
    makeSupplier("Insulated Water Bottle 100ml Stainless Steel Mini"),
  );
  assert.equal(result.confidenceBand, "LOW");
  assert.ok(result.confidence <= 30, `expected <= 30, got ${result.confidence}`);
  const conflict = result.contradictions.find(
    (entry) => entry.name === "unitConflict",
  );
  assert.ok(conflict, "a unit conflict must be recorded");
  assert.equal(conflict?.severity, "hard");
});

test("matching quantity/count is rewarded", () => {
  const result = scoreCandidate(
    makeMarketplace("USB-C Cables 3 Pack Fast Charging Nylon Braided"),
    makeSupplier("USB C Cable 3 Pack Nylon Braided Fast Charger"),
  );
  assert.ok(
    result.signals.some((signal) => signal.name === "quantityAgreement"),
    "a matching pack count must register a signal",
  );
});

test("conflicting quantity/count is penalized", () => {
  const result = scoreCandidate(
    makeMarketplace("USB-C Cables 3 Pack Fast Charging Nylon Braided"),
    makeSupplier("USB C Cable 10 Pack Nylon Braided Fast Charger"),
  );
  assert.ok(
    result.contradictions.some((entry) => entry.name === "quantityConflict"),
    "a conflicting pack count must be recorded",
  );
  assert.ok(result.confidence < 40);
});

test("missing optional fields never break scoring", () => {
  const result = scoreCandidate(
    makeMarketplace("Soundcore Life Q30 Headphones", {
      imageUrl: null,
      listingUrl: null,
      price: null,
      currency: null,
      condition: null,
      sellerName: null,
      sellerFeedbackPercentage: null,
      shippingCost: null,
      shippingCurrency: null,
      location: null,
    }),
    makeSupplier("Soundcore Life Q30 Headphones", {
      sku: null,
      imageUrl: null,
      supplierPrice: null,
      currency: null,
      category: null,
      productUrl: null,
    }),
  );
  assert.equal(result.confidenceBand, "HIGH");
  assert.ok(result.confidence >= 70);
});

test("no meaningful overlap yields zero confidence and LOW band", () => {
  const result = scoreCandidate(
    makeMarketplace("Dog Chew Toy Natural Rubber"),
    makeSupplier("LED Desk Lamp Dimmable Touch Control"),
  );
  assert.equal(result.confidence, 0);
  assert.equal(result.confidenceBand, "LOW");
  assert.equal(result.signals.length, 0);
});

test("price is never used as product-identity evidence", () => {
  const cheap = scoreCandidate(
    makeMarketplace("Soundcore Life Q30 Headphones", { price: "29.99" }),
    makeSupplier("Soundcore Life Q30 Headphones", { supplierPrice: "12.50" }),
  );
  const expensive = scoreCandidate(
    makeMarketplace("Soundcore Life Q30 Headphones", { price: "899.00" }),
    makeSupplier("Soundcore Life Q30 Headphones", { supplierPrice: "0.50" }),
  );
  assert.equal(cheap.confidence, expensive.confidence);
  assert.ok(
    [...cheap.signals, ...cheap.contradictions].every(
      (entry) => !/price/i.test(entry.name) && !/price/i.test(entry.detail),
    ),
  );
});

test("brand agreement adds confidence; brand conflict caps it", () => {
  const agreement = scoreCandidate(
    makeMarketplace("Sony WH-1000XM5 Headphones"),
    makeSupplier("Sony WH-1000XM5 Over-Ear Headphones"),
  );
  assert.ok(agreement.signals.some((signal) => signal.name === "brandAgreement"));

  const conflict = scoreCandidate(
    makeMarketplace("Sony WH-1000XM5 Headphones"),
    makeSupplier("JBL WH-1000XM5 Over-Ear Headphones"),
  );
  const brandConflict = conflict.contradictions.find(
    (entry) => entry.name === "brandConflict",
  );
  assert.ok(brandConflict);
  assert.equal(brandConflict?.severity, "hard");
  assert.ok(
    conflict.confidence <= 20,
    `expected <= 20, got ${conflict.confidence}`,
  );
  assert.ok(conflict.confidence < agreement.confidence);
});

test("scoring is deterministic for identical inputs", () => {
  const market = makeMarketplace("Anker Soundcore Life Q30 Wireless Headphones");
  const supplier = makeSupplier("Soundcore Life Q30 ANC Headphones");
  const first = scoreCandidate(market, supplier);
  const second = scoreCandidate(market, supplier);
  assert.deepEqual(first, second);
});

test("no candidate is ever labelled exact or guaranteed", () => {
  const result = scoreCandidate(
    makeMarketplace("Soundcore Life Q30 Headphones"),
    makeSupplier("Soundcore Life Q30 Headphones"),
  );
  assert.equal(result.confidenceBand, "HIGH");
  // Even a title compared against itself does not reach the top of the scale:
  // V1 deliberately reserves headroom for stronger (image/identifier) evidence.
  assert.ok(result.confidence < 100, "confidence must reserve headroom");
  assert.doesNotMatch(result.explanation, /exact|guaranteed/i);
});
