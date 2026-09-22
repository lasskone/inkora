import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectShippingQuote,
  selectSupplierVariant,
} from "@/lib/economics/selection";
import type { ShippingQuote, SupplierVariant } from "@/lib/supplier/types";

const DESTINATION = "US";

function makeVariant(overrides: Partial<SupplierVariant> = {}): SupplierVariant {
  return {
    externalId: "vid-1",
    sku: "CJ-SKU-1",
    title: "Default",
    price: "12.00",
    availableInventory: 10,
    warehouseCountries: [],
    ...overrides,
  };
}

function makeQuote(overrides: Partial<ShippingQuote> = {}): ShippingQuote {
  return {
    method: "CJPacket",
    cost: "5.00",
    currency: "USD",
    transitTime: "7-17",
    originCountry: "CN",
    provenance: "OFFICIAL",
    ...overrides,
  };
}

// --- Variant selection ------------------------------------------------------

test("selects the only variant definitively", () => {
  const selection = selectSupplierVariant([makeVariant()], DESTINATION);

  assert.ok(selection);
  assert.equal(selection?.basis, "SELECTED_VARIANT");
  assert.equal(selection?.variant.externalId, "vid-1");
  assert.deepEqual(selection?.warnings, []);
});

test("treats identically priced variants as an unambiguous cost", () => {
  const selection = selectSupplierVariant(
    [
      makeVariant({ externalId: "a", price: "12.00" }),
      makeVariant({ externalId: "b", price: "12.00" }),
    ],
    DESTINATION,
  );

  assert.equal(selection?.basis, "SELECTED_VARIANT");
  assert.equal(selection?.variant.price, "12.00");
});

test("marks differing variant costs as a reference, not definitive", () => {
  const selection = selectSupplierVariant(
    [
      makeVariant({ externalId: "a", price: "10.00" }),
      makeVariant({ externalId: "b", price: "20.00" }),
    ],
    DESTINATION,
  );

  assert.equal(selection?.basis, "VARIANT_REFERENCE");
  assert.equal(selection?.variant.externalId, "a");
  assert.ok(
    selection?.warnings.some((warning) => /reference lower bound/i.test(warning)),
    "must warn the cost is a reference",
  );
});

test("prefers a variant stocked in the destination country when costs differ", () => {
  const selection = selectSupplierVariant(
    [
      makeVariant({ externalId: "cn-only", price: "8.00", warehouseCountries: ["CN"] }),
      makeVariant({ externalId: "us-stock", price: "9.00", warehouseCountries: ["US"] }),
    ],
    DESTINATION,
  );

  assert.equal(selection?.basis, "VARIANT_REFERENCE");
  assert.equal(selection?.variant.externalId, "us-stock");
});

test("warns when no variant is stocked in the destination country", () => {
  const selection = selectSupplierVariant(
    [
      makeVariant({ externalId: "a", price: "10.00", warehouseCountries: ["CN"] }),
      makeVariant({ externalId: "b", price: "20.00", warehouseCountries: ["CN"] }),
    ],
    DESTINATION,
  );

  assert.ok(
    selection?.warnings.some((warning) => /destination country/i.test(warning)),
    "must warn about missing destination-country stock",
  );
});

test("excludes variants without an id or a usable price", () => {
  assert.equal(
    selectSupplierVariant(
      [makeVariant({ externalId: null }), makeVariant({ price: null })],
      DESTINATION,
    ),
    null,
  );
  assert.equal(selectSupplierVariant([], DESTINATION), null);
});

test("variant selection is deterministic for identical inputs", () => {
  const variants = [
    makeVariant({ externalId: "b", price: "20.00" }),
    makeVariant({ externalId: "a", price: "10.00" }),
  ];
  assert.deepEqual(
    selectSupplierVariant(variants, DESTINATION),
    selectSupplierVariant(variants, DESTINATION),
  );
});

// --- Shipping quote selection -----------------------------------------------

test("prefers a quote that documents its delivery time at equal cost", () => {
  const quotes = [
    makeQuote({ method: "NoInfo", cost: "5.00", transitTime: null }),
    makeQuote({ method: "Documented", cost: "5.00", transitTime: "4-10" }),
  ];

  assert.equal(selectShippingQuote(quotes)?.method, "Documented");
});

test("chooses the lowest cost among quotes with delivery info", () => {
  const quotes = [
    makeQuote({ method: "Fast", cost: "8.00", transitTime: "2-5" }),
    makeQuote({ method: "Cheap", cost: "4.71", transitTime: "7-17" }),
  ];

  assert.equal(selectShippingQuote(quotes)?.method, "Cheap");
});

test("excludes quotes without a method name or a usable price", () => {
  const quotes = [
    makeQuote({ method: "", cost: "5.00" }),
    makeQuote({ method: "Unpriced", cost: null }),
    makeQuote({ method: "Free", cost: "0.00", transitTime: "10-20" }),
  ];

  const selected = selectShippingQuote(quotes);
  assert.equal(selected?.method, "Free");
});

test("quote selection is deterministic", () => {
  const quotes = [
    makeQuote({ method: "B", cost: "5.00" }),
    makeQuote({ method: "A", cost: "5.00" }),
  ];
  assert.equal(selectShippingQuote(quotes)?.method, "A");
  assert.equal(selectShippingQuote(quotes)?.method, "A");
});

test("returns null when no quote is usable", () => {
  assert.equal(selectShippingQuote([]), null);
  assert.equal(selectShippingQuote([makeQuote({ cost: null })]), null);
});
