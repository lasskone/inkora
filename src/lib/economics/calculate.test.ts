import { test } from "node:test";
import assert from "node:assert/strict";

import { computeEconomics, evaluateCompleteness, type EconomicsInput } from "@/lib/economics/calculate";
import { calculateEbayFees } from "@/lib/economics/fee-engine";
import type { ShippingQuote } from "@/lib/supplier/types";

/**
 * The economics contract: profit and margin appear only when every required
 * component exists, and non-definitive inputs surface as PARTIAL rather than as
 * silently-downgraded COMPLETE figures.
 *
 * Default fixture is a deliberately tight single-unit order so the arithmetic is
 * checkable by hand:
 *   revenue  = $29.99 + $0.00      = 2999c
 *   landed   = $12.50 + $4.71      = 1721c
 *   fee      = 13.25% of $29.99    =  397c
 *   profit   = 2999 - 1721 - 397   =  881c = $8.81
 *   margin   = 881 / 2999          = 29.37%
 */

const USD = "USD";
const DESTINATION = {
  countryCode: "US",
  postalCode: null,
  label: "baseline destination US",
};

function quote(overrides: Partial<ShippingQuote> = {}): ShippingQuote {
  return {
    method: "USPS+",
    cost: "4.71",
    currency: "USD",
    transitTime: "4-10",
    originCountry: "CN",
    provenance: "OFFICIAL",
    ...overrides,
  };
}

function makeInput(overrides: Partial<EconomicsInput> = {}): EconomicsInput {
  const base: EconomicsInput = {
    marketplaceItemId: "v1|265983500898|0",
    itemPriceCents: 2999,
    buyerShippingCents: 0,
    currency: USD,
    supplierProductId: "cj-pid-1",
    selectedVariant: { externalId: "vid-1", sku: "CJ-SKU-1", title: "Black" },
    supplierProductCostCents: 1250,
    supplierCostBasis: "SELECTED_VARIANT",
    shippingQuotes: [quote()],
    selectedQuote: quote(),
    shippingDestination: DESTINATION,
    feeResult: calculateEbayFees({
      itemPriceCents: 2999,
      buyerShippingCents: 0,
      currency: USD,
    }),
    inputWarnings: [],
    calculatedAt: "2026-09-21T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

test("standard case: complete economics with exact profit and margin", () => {
  const result = computeEconomics(makeInput());

  assert.equal(result.completeness, "COMPLETE");
  assert.equal(result.itemPrice, "29.99");
  assert.equal(result.buyerShipping, "0.00");
  assert.equal(result.grossMarketplaceRevenue, "29.99");
  assert.equal(result.supplierProductCost, "12.50");
  assert.equal(result.supplierShippingCost, "4.71");
  assert.equal(result.landedSupplierCost, "17.21");
  assert.equal(result.marketplaceFee, "3.97");
  assert.equal(result.estimatedProfit, "8.81");
  assert.equal(result.marginPercent, "29.38");
  assert.deepEqual(result.warnings, []);
});

test("zero buyer-paid shipping still completes", () => {
  const result = computeEconomics(makeInput({ buyerShippingCents: 0 }));

  assert.equal(result.completeness, "COMPLETE");
  assert.equal(result.buyerShipping, "0.00");
  assert.equal(result.grossMarketplaceRevenue, "29.99");
});

test("buyer-paid shipping adds to revenue and to the fee basis", () => {
  const result = computeEconomics(
    makeInput({
      buyerShippingCents: 500,
      feeResult: calculateEbayFees({
        itemPriceCents: 2999,
        buyerShippingCents: 500,
        currency: USD,
      }),
    }),
  );

  assert.equal(result.completeness, "COMPLETE");
  assert.equal(result.grossMarketplaceRevenue, "34.99");
  assert.equal(result.marketplaceFee, "4.64");
  // 3499 - 1721 - 464 = 1314
  assert.equal(result.estimatedProfit, "13.14");
  assert.equal(result.marginPercent, "37.55");
});


test("missing supplier shipping leaves economics unavailable", () => {
  const result = computeEconomics(
    makeInput({ selectedQuote: null, shippingQuotes: [] }),
  );

  assert.equal(result.completeness, "UNAVAILABLE");
  assert.equal(result.supplierShippingCost, null);
  assert.equal(result.landedSupplierCost, null);
  assert.equal(result.estimatedProfit, null);
  assert.equal(result.marginPercent, null);
  assert.ok(
    result.warnings.some((warning) =>
      /no usable shipping quote for the baseline destination/i.test(warning),
    ),
  );
});

test("missing supplier cost leaves economics unavailable", () => {
  const result = computeEconomics(
    makeInput({ supplierProductCostCents: null, supplierCostBasis: null }),
  );

  assert.equal(result.completeness, "UNAVAILABLE");
  assert.equal(result.estimatedProfit, null);
});

test("missing marketplace price leaves economics unavailable", () => {
  const result = computeEconomics(
    makeInput({
      itemPriceCents: null,
      feeResult: calculateEbayFees({
        itemPriceCents: null,
        buyerShippingCents: 0,
        currency: USD,
      }),
    }),
  );

  assert.equal(result.completeness, "UNAVAILABLE");
  assert.equal(result.grossMarketplaceRevenue, null);
  assert.equal(result.estimatedProfit, null);
});

test("zero marketplace price leaves economics unavailable", () => {
  const result = computeEconomics(
    makeInput({
      itemPriceCents: 0,
      feeResult: calculateEbayFees({
        itemPriceCents: 0,
        buyerShippingCents: 0,
        currency: USD,
      }),
    }),
  );

  assert.equal(result.completeness, "UNAVAILABLE");
  assert.equal(result.estimatedProfit, null);
});

test("negative profit is reported honestly, not clamped to zero", () => {
  const result = computeEconomics(
    makeInput({
      itemPriceCents: 1000,
      feeResult: calculateEbayFees({
        itemPriceCents: 1000,
        buyerShippingCents: 0,
        currency: USD,
      }),
    }),
  );

  assert.equal(result.completeness, "COMPLETE");
  // revenue 1000 - landed 1721 - fee 133 (13.25% of $10, above the $0.30 min)
  assert.equal(result.marketplaceFee, "1.33");
  assert.equal(result.estimatedProfit, "-8.54");
  assert.equal(result.marginPercent, "-85.40");
});

test("margin is derived from profit over gross revenue", () => {
  const result = computeEconomics(
    makeInput({
      itemPriceCents: 5000,
      feeResult: calculateEbayFees({
        itemPriceCents: 5000,
        buyerShippingCents: 0,
        currency: USD,
      }),
    }),
  );

  // revenue 5000 - landed 1721 - fee 663 (13.25% of $50) = 2616
  assert.equal(result.estimatedProfit, "26.16");
  assert.equal(result.marginPercent, "52.32");
});

test("a reference variant cost makes the result partial", () => {
  const result = computeEconomics(
    makeInput({ supplierCostBasis: "VARIANT_REFERENCE" }),
  );

  assert.equal(result.completeness, "PARTIAL");
  assert.equal(result.estimatedProfit, "8.81");
  assert.ok(
    result.warnings.some((warning) => /reference value/i.test(warning)),
    "must explain that the cost is a reference",
  );
});

test("a catalogue-minimum cost makes the result partial", () => {
  const result = computeEconomics(
    makeInput({ supplierCostBasis: "CATALOG_MINIMUM" }),
  );

  assert.equal(result.completeness, "PARTIAL");
  assert.ok(result.warnings.some((warning) => /reference value/i.test(warning)));
});

test("an unpriced buyer shipping line makes the result partial", () => {
  const result = computeEconomics(
    makeInput({
      buyerShippingCents: null,
      feeResult: calculateEbayFees({
        itemPriceCents: 2999,
        buyerShippingCents: null,
        currency: USD,
      }),
    }),
  );

  assert.equal(result.completeness, "PARTIAL");
  assert.equal(result.buyerShipping, null);
  assert.ok(
    result.warnings.some((warning) => /no priced shipping option/i.test(warning)),
  );
});

test("an incomplete fee rule leaves economics unavailable", () => {
  const result = computeEconomics(
    makeInput({
      itemPriceCents: null,
      feeResult: calculateEbayFees({
        itemPriceCents: null,
        buyerShippingCents: null,
        currency: USD,
      }),
    }),
  );

  assert.equal(result.feeStatus, "INCOMPLETE");
  assert.equal(result.completeness, "UNAVAILABLE");
  assert.equal(result.estimatedProfit, null);
});

test("a non-USD listing is not economicsed with an invented exchange rate", () => {
  const result = computeEconomics(makeInput({ currency: "EUR" }));

  assert.equal(result.completeness, "UNAVAILABLE");
  assert.equal(result.estimatedProfit, null);
  assert.ok(
    result.warnings.some((warning) =>
      /Cross-currency economics are not supported/i.test(warning),
    ),
  );
});

test("a missing currency code defaults to USD and is flagged partial", () => {
  const result = computeEconomics(makeInput({ currency: null }));

  assert.equal(result.completeness, "PARTIAL");
  assert.equal(result.currency, "USD");
  assert.ok(result.warnings.some((warning) => /no currency code/i.test(warning)));
});

test("selected variant and shipping method are carried into the result", () => {
  const result = computeEconomics(makeInput());

  assert.equal(result.selectedVariant?.externalId, "vid-1");
  assert.equal(result.supplierShippingMethod, "USPS+");
  assert.equal(result.supplierShippingTransitTime, "4-10");
  assert.equal(result.shippingQuotes.length, 1);
});

test("derived values are never labelled official", () => {
  const result = computeEconomics(makeInput());

  assert.equal(result.provenance.itemPrice, "OFFICIAL");
  assert.equal(result.provenance.supplierProductCost, "OFFICIAL");
  assert.equal(result.provenance.supplierShippingCost, "OFFICIAL");
  assert.equal(result.provenance.marketplaceFee, "ESTIMATED");
  assert.equal(result.provenance.estimatedProfit, "ESTIMATED");
  assert.equal(result.provenance.marginPercent, "ESTIMATED");
});

test("a non-definitive supplier cost is not labelled official", () => {
  for (const basis of ["VARIANT_REFERENCE", "CATALOG_MINIMUM"] as const) {
    const result = computeEconomics(makeInput({ supplierCostBasis: basis }));
    assert.equal(
      result.provenance.supplierProductCost,
      "ESTIMATED",
      `${basis} must not claim OFFICIAL provenance`,
    );
  }

  const definitive = computeEconomics(
    makeInput({ supplierCostBasis: "SELECTED_VARIANT" }),
  );
  assert.equal(definitive.provenance.supplierProductCost, "OFFICIAL");
});

test("assumptions are always stated", () => {
  const result = computeEconomics(makeInput());

  assert.ok(result.assumptions.length >= 3);
  assert.ok(
    result.assumptions.some((assumption) => /single-unit order/i.test(assumption)),
  );
  assert.ok(
    result.assumptions.some((assumption) => /baseline destination/i.test(assumption)),
  );
});

test("completeness is a pure function of the inputs", () => {
  const input = makeInput();
  assert.deepEqual(evaluateCompleteness(input), evaluateCompleteness(input));
  assert.equal(evaluateCompleteness(input).completeness, "COMPLETE");
});

test("economics are deterministic for identical inputs", () => {
  assert.deepEqual(computeEconomics(makeInput()), computeEconomics(makeInput()));
});

