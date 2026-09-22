import { test } from "node:test";
import assert from "node:assert/strict";

import { calculateEbayFees, FEE_ENGINE_VERSION } from "@/lib/economics/fee-engine";

/**
 * The fee engine must be deterministic, versioned, and honest: same inputs ⇒
 * same output, the version travels with the result, and an estimated fee always
 * carries its caveats.
 */

const USD = "USD";

test("applies the standard final value fee rate to item price plus buyer shipping", () => {
  const result = calculateEbayFees({
    itemPriceCents: 2999,
    buyerShippingCents: 500,
    currency: USD,
  });

  assert.equal(result.status, "ESTIMATED");
  // 13.25% of $34.99 = $4.636175 -> $4.64
  assert.equal(result.total, "4.64");
  assert.equal(result.feeBasis, "34.99");
  assert.equal(result.currency, USD);
});

test("never claims to be an exact eBay charge", () => {
  const result = calculateEbayFees({
    itemPriceCents: 10000,
    buyerShippingCents: 0,
    currency: USD,
  });

  assert.equal(result.status, "ESTIMATED");
  assert.equal(result.provenance, "ESTIMATED");
  assert.ok(result.caveats.length > 0);
  assert.ok(
    result.caveats.some((caveat) => /not an exact eBay charge/.test(caveat)),
  );
  assert.ok(
    result.caveats.some((caveat) => /subscriber/i.test(caveat)),
    "must disclose that subscription status is unknown",
  );
});

test("reports the engine version and rule source", () => {
  const result = calculateEbayFees({
    itemPriceCents: 10000,
    buyerShippingCents: 0,
    currency: USD,
  });

  assert.equal(result.engineVersion, FEE_ENGINE_VERSION);
  assert.ok(result.ruleSource.length > 0);
});

test("breaks the fee out into named components", () => {
  const result = calculateEbayFees({
    itemPriceCents: 10000,
    buyerShippingCents: 0,
    currency: USD,
  });

  const names = result.breakdown.map((component) => component.name);
  assert.deepEqual(names, ["finalValueFee", "insertionFee"]);

  const finalValue = result.breakdown.find(
    (component) => component.name === "finalValueFee",
  );
  assert.ok(finalValue);
  assert.equal(finalValue?.amount, "13.25");
  assert.equal(finalValue?.rate, "13.2500");

  const insertion = result.breakdown.find(
    (component) => component.name === "insertionFee",
  );
  assert.ok(insertion);
  assert.equal(insertion?.amount, "0.00");
});

test("enforces the per-order minimum final value fee", () => {
  // 13.25% of $1.00 is $0.1325 -> $0.13, below the $0.30 minimum.
  const result = calculateEbayFees({
    itemPriceCents: 100,
    buyerShippingCents: 0,
    currency: USD,
  });

  assert.equal(result.total, "0.30");
});

test("computes the fee on the item price alone when buyer shipping is unknown", () => {
  const result = calculateEbayFees({
    itemPriceCents: 5000,
    buyerShippingCents: null,
    currency: USD,
  });

  // 13.25% of $50.00 = $6.625 -> $6.63
  assert.equal(result.total, "6.63");
  assert.equal(result.feeBasis, "50.00");
});

test("rounds deterministically (identical inputs, identical output)", () => {
  const input = { itemPriceCents: 2999, buyerShippingCents: 499, currency: USD };
  assert.deepEqual(calculateEbayFees(input), calculateEbayFees(input));
});

test("is incomplete without a marketplace price", () => {
  const result = calculateEbayFees({
    itemPriceCents: null,
    buyerShippingCents: 500,
    currency: USD,
  });

  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.total, null);
  assert.equal(result.feeBasis, null);
  assert.ok(
    result.breakdown.some((component) => /no fee can be calculated/i.test(component.note)),
  );
});

test("is incomplete when the marketplace price is not positive", () => {
  const zero = calculateEbayFees({
    itemPriceCents: 0,
    buyerShippingCents: 0,
    currency: USD,
  });
  assert.equal(zero.status, "INCOMPLETE");
  assert.equal(zero.total, null);

  const negative = calculateEbayFees({
    itemPriceCents: -1000,
    buyerShippingCents: 0,
    currency: USD,
  });
  assert.equal(negative.status, "INCOMPLETE");
  assert.equal(negative.total, null);
});

test("documents that category caps and tax are not modeled", () => {
  const result = calculateEbayFees({
    itemPriceCents: 100000,
    buyerShippingCents: 0,
    currency: USD,
  });

  assert.ok(
    result.caveats.some((caveat) => /category/i.test(caveat) && /not modeled/i.test(caveat)),
    "must disclose that category maximums are not modeled",
  );
  assert.ok(
    result.caveats.some((caveat) => /tax/i.test(caveat) && /understate/i.test(caveat)),
    "must disclose that excluding tax can understate the fee",
  );
});

test("accepts category ids without changing the V1 default rule", () => {
  const withCategory = calculateEbayFees({
    itemPriceCents: 5000,
    buyerShippingCents: 0,
    currency: USD,
    categoryIds: ["9355"],
  });
  const without = calculateEbayFees({
    itemPriceCents: 5000,
    buyerShippingCents: 0,
    currency: USD,
  });

  assert.deepEqual(withCategory.total, without.total);
});
