import { test } from "node:test";
import assert from "node:assert/strict";

import {
  centsToDecimalOrNull,
  clampLimit,
  DEFAULT_HISTORY_LIMIT,
  marginPercentToPercentCents,
  marketplaceProductToSnapshotColumns,
  MAX_HISTORY_LIMIT,
  numericToNumber,
  percentCentsToMarginPercent,
  supplierProductToSnapshotColumns,
  toCentsOrNull,
} from "@/lib/persistence/mapping";
import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { SupplierProduct } from "@/lib/supplier/types";

/**
 * The persistence money contract (docs/DATABASE.md §8): every figure crosses the
 * database boundary as integer minor units, converts back exactly, and an absent
 * value stays `null` — never a fabricated zero. Margin is a *separate*
 * percent-cents encoding, deliberately not interchangeable with money.
 */

function makeMarketplaceProduct(
  overrides: Partial<MarketplaceProduct> = {},
): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: "v1|265983500898|0",
    title: "Ink cartridge, black",
    imageUrl: "https://example.example/img.jpg",
    listingUrl: "https://example.example/item/1",
    price: "29.99",
    currency: "USD",
    condition: "New",
    sellerName: "seller-42",
    sellerFeedbackPercentage: 98.1,
    shippingCost: "0.00",
    shippingCurrency: "USD",
    location: "US",
    provenance: "OFFICIAL",
    fetchedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function makeSupplierProduct(
  overrides: Partial<SupplierProduct> = {},
): SupplierProduct {
  return {
    supplier: "cj",
    externalId: "cj-pid-1",
    sku: "CJ-SKU-1",
    title: "Compatible ink cartridge",
    imageUrl: null,
    productUrl: null,
    category: null,
    supplierPrice: "12.00",
    currency: "USD",
    availableInventory: 10,
    warehouseCountry: "CN",
    shippingOrigin: null,
    variants: [],
    provenance: "OFFICIAL",
    fetchedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

test("toCentsOrNull converts decimal strings to integer minor units", () => {
  assert.equal(toCentsOrNull("29.99"), 2999);
  assert.equal(toCentsOrNull("0"), 0);
  assert.equal(toCentsOrNull("1000"), 100000);
});

test("toCentsOrNull keeps the sign for a loss", () => {
  assert.equal(toCentsOrNull("-12.34"), -1234);
});

test("toCentsOrNull yields null instead of a guessed zero", () => {
  assert.equal(toCentsOrNull(null), null);
  assert.equal(toCentsOrNull(undefined), null);
  assert.equal(toCentsOrNull(""), null);
  assert.equal(toCentsOrNull("not a price"), null);
});

test("centsToDecimalOrNull is the exact inverse of toCentsOrNull", () => {
  assert.equal(centsToDecimalOrNull(2999), "29.99");
  assert.equal(centsToDecimalOrNull(0), "0.00");
  assert.equal(centsToDecimalOrNull(5), "0.05");
  assert.equal(centsToDecimalOrNull(null), null);
});

test("centsToDecimalOrNull renders a stored loss as a loss, never clamped", () => {
  assert.equal(centsToDecimalOrNull(-1234), "-12.34");
  assert.equal(centsToDecimalOrNull(-1), "-0.01");
});

test("money round-trips without drift", () => {
  // `formatCents` always emits two decimals, so the canonical round-trip form of
  // a whole amount is its two-decimal spelling.
  for (const decimal of ["29.99", "0.01", "1234.56", "-7.77", "0.00", "100.00"]) {
    assert.equal(centsToDecimalOrNull(toCentsOrNull(decimal)), decimal);
  }
});

test("marginPercentToPercentCents stores 1/100 of a percent, not minor units", () => {
  assert.equal(marginPercentToPercentCents("36.99"), 3699);
  assert.equal(marginPercentToPercentCents("0"), 0);
  assert.equal(marginPercentToPercentCents("100"), 10000);
});

test("marginPercentToPercentCents keeps a negative margin exact", () => {
  assert.equal(marginPercentToPercentCents("-4.20"), -420);
});

test("marginPercentToPercentCents yields null for an absent margin", () => {
  assert.equal(marginPercentToPercentCents(null), null);
  assert.equal(marginPercentToPercentCents(undefined), null);
  assert.equal(marginPercentToPercentCents("unavailable"), null);
});

test("percentCentsToMarginPercent inverts marginPercentToPercentCents", () => {
  assert.equal(percentCentsToMarginPercent(3699), "36.99");
  assert.equal(percentCentsToMarginPercent(-420), "-4.2");
  assert.equal(percentCentsToMarginPercent(null), null);

  for (const percent of ["36.99", "0", "100", "-4.2", "12.5"]) {
    assert.equal(
      percentCentsToMarginPercent(marginPercentToPercentCents(percent)),
      percent,
    );
  }
});

test("money always formats to two decimals, margin does not", () => {
  // 3650 encodes both $36.50 and 36.5%. The numeric coincidence is exactly why
  // money and margin need separate helpers: money's contract is a fixed
  // two-decimal string, margin's is a plain decimal — swapping them would
  // either invent precision or drop it.
  assert.equal(toCentsOrNull("36.50"), marginPercentToPercentCents("36.5"));
  assert.equal(centsToDecimalOrNull(3650), "36.50");
  assert.equal(percentCentsToMarginPercent(3650), "36.5");
});

test("numericToNumber accepts both shapes Supabase can return", () => {
  assert.equal(numericToNumber(42), 42);
  assert.equal(numericToNumber("42"), 42);
  assert.equal(numericToNumber(" 42 "), 42);
  assert.equal(numericToNumber(null), null);
  assert.equal(numericToNumber(undefined), null);
  assert.equal(numericToNumber(Number.NaN), null);
  assert.equal(numericToNumber("not numeric"), null);
  assert.equal(numericToNumber({}), null);
});

test("marketplaceProductToSnapshotColumns keeps absent fields null", () => {
  const columns = marketplaceProductToSnapshotColumns(
    makeMarketplaceProduct({ price: "29.99", shippingCost: null, imageUrl: null }),
  );

  assert.equal(columns.priceCents, 2999);
  assert.equal(columns.buyerShippingCents, null);
  assert.equal(columns.imageUrl, null);
  assert.equal(columns.currency, "USD");
  assert.equal(columns.provenance, "OFFICIAL");
  assert.equal(columns.title, "Ink cartridge, black");
  assert.equal(columns.sellerIdentifier, "seller-42");
  assert.equal(columns.sellerFeedbackPercentage, 98.1);
});

test("supplierProductToSnapshotColumns stores the catalogue reference price", () => {
  const columns = supplierProductToSnapshotColumns(
    makeSupplierProduct({ supplierPrice: "23.36 -- 23.42" }),
  );

  // The low end of a documented CJ range, per the money primitives.
  assert.equal(columns.catalogReferencePriceCents, 2336);
  assert.equal(columns.currency, "USD");
  assert.equal(columns.availableInventory, 10);
  assert.equal(columns.warehouseCountry, "CN");
});

test("supplierProductToSnapshotColumns keeps an absent price absent", () => {
  const columns = supplierProductToSnapshotColumns(
    makeSupplierProduct({ supplierPrice: null }),
  );
  assert.equal(columns.catalogReferencePriceCents, null);
});

test("clampLimit applies the documented ceiling and a floor of one", () => {
  assert.equal(clampLimit(5), 5);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-10), 1);
  assert.equal(clampLimit(1000), MAX_HISTORY_LIMIT);
});

test("clampLimit falls back to the documented default for unusable input", () => {
  assert.equal(clampLimit(undefined), DEFAULT_HISTORY_LIMIT);
  assert.equal(clampLimit(Number.NaN), DEFAULT_HISTORY_LIMIT);
  assert.equal(clampLimit(Number.POSITIVE_INFINITY), DEFAULT_HISTORY_LIMIT);
});

test("clampLimit truncates a fractional page size rather than rounding it", () => {
  assert.equal(clampLimit(7.9), 7);
});

