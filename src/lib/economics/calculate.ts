/**
 * Pure economics calculation: landed cost, estimated profit, margin, and
 * completeness.
 *
 * This module contains *only* deterministic functions over already-parsed
 * values — no HTTP, no tokens, no `server-only`. External acquisition (eBay
 * price, CJ variant cost, CJ shipping quote) happens upstream and feeds these
 * functions, so every number below is unit-testable without a network
 * (docs/ARCHITECTURE.md §6.3 and §10).
 *
 * Formula, stated once and implemented exactly:
 *
 * ```text
 *   grossMarketplaceRevenue = eBay item price + buyer-paid shipping
 *   landedSupplierCost       = supplier product cost + supplier shipping cost
 *   estimatedProfit          = grossMarketplaceRevenue
 *                              - landedSupplierCost
 *                              - marketplace fees
 *   marginPercent            = estimatedProfit / grossMarketplaceRevenue * 100
 * ```
 *
 * If any component needed for profit is missing, profit and margin are `null`
 * and the result is `UNAVAILABLE` — never a fabricated figure.
 */

import type { ShippingQuote } from "@/lib/supplier/types";
import type { Provenance } from "@/lib/marketplace/types";
import type {
  EconomicsCompleteness,
  EconomicsProvenance,
  EconomicsResult,
  FeeResult,
  ShippingDestination,
  SupplierCostBasis,
} from "./types";
import { ECONOMICS_ENGINE_VERSION } from "./types";
import {
  formatCents,
  parseDecimalToCents,
  percentRatioCents,
  sumCents,
} from "./money";

/** All amounts arrive here already parsed into minor units (cents). */
export interface EconomicsInput {
  marketplaceItemId: string;
  itemPriceCents: number | null;
  buyerShippingCents: number | null;
  /** ISO 4217 currency of the marketplace amounts, as reported by eBay. */
  currency: string | null;

  supplierProductId: string;
  selectedVariant: {
    externalId: string;
    sku: string | null;
    title: string | null;
  } | null;
  supplierProductCostCents: number | null;
  supplierCostBasis: SupplierCostBasis | null;

  /** Every quote the supplier returned (kept for transparency). */
  shippingQuotes: ShippingQuote[];
  /** The quote the deterministic policy selected, or `null`. */
  selectedQuote: ShippingQuote | null;
  shippingDestination: ShippingDestination;

  feeResult: FeeResult;

  /** Caveats accumulated while acquiring the inputs (variant selection, …). */
  inputWarnings: string[];
  /** ISO 8601 timestamp of the calculation. */
  calculatedAt: string;
}

/**
 * CJ documents its prices and freight in USD, and Inkora's marketplace side is
 * US eBay. V1 performs no currency conversion — it never invents an exchange
 * rate — so a non-USD listing cannot be economicsed.
 */
const SUPPORTED_CURRENCY = "USD";

interface CurrencyResolution {
  /** Effective currency code used for the result. */
  code: string;
  assumed: boolean;
  supported: boolean;
}

function resolveCurrency(currency: string | null): CurrencyResolution {
  if (currency === null || currency.trim() === "") {
    return { code: SUPPORTED_CURRENCY, assumed: true, supported: true };
  }
  return {
    code: currency.trim().toUpperCase(),
    assumed: false,
    supported: currency.trim().toUpperCase() === SUPPORTED_CURRENCY,
  };
}


/**
 * Decides completeness from the components actually present.
 *
 * Actionable profit requires, at minimum: a positive marketplace price, a
 * supplier product cost, a computable marketplace fee, and a supplier shipping
 * quote. Missing any of them → `UNAVAILABLE`. Present but non-definitive (a
 * reference variant cost, an incomplete fee rule, an unpriced buyer shipping
 * line, or an assumed currency) → `PARTIAL`.
 */
export function evaluateCompleteness(input: EconomicsInput): {
  completeness: EconomicsCompleteness;
  reasons: string[];
} {
  const reasons: string[] = [];

  const currency = resolveCurrency(input.currency);
  if (!currency.supported) {
    reasons.push(
      `Cross-currency economics are not supported in V1: the listing is priced in ${currency.code} while supplier costs are USD. No exchange rate is assumed.`,
    );
    return { completeness: "UNAVAILABLE", reasons };
  }

  if (input.itemPriceCents === null) {
    reasons.push("The eBay listing has no sale price, so no revenue can be computed.");
    return { completeness: "UNAVAILABLE", reasons };
  }
  if (input.itemPriceCents <= 0) {
    reasons.push(
      "The eBay listing price is zero or negative, so it is not a sellable basis for economics.",
    );
    return { completeness: "UNAVAILABLE", reasons };
  }

  if (input.supplierProductCostCents === null) {
    reasons.push("No supplier product cost could be resolved for this candidate.");
    return { completeness: "UNAVAILABLE", reasons };
  }

  if (input.selectedQuote === null) {
    reasons.push(
      "The supplier returned no usable shipping quote for the baseline destination, so landed cost is unknown.",
    );
    return { completeness: "UNAVAILABLE", reasons };
  }

  const shippingCents = parseDecimalToCents(input.selectedQuote.cost);
  if (shippingCents === null) {
    reasons.push("The selected supplier shipping quote carries no usable price.");
    return { completeness: "UNAVAILABLE", reasons };
  }

  if (input.feeResult.total === null) {
    reasons.push("The marketplace fee could not be calculated, so profit is unknown.");
    return { completeness: "UNAVAILABLE", reasons };
  }

  // Everything required is present. Now: is it definitive?
  const partial: string[] = [];

  if (
    input.supplierCostBasis === "VARIANT_REFERENCE" ||
    input.supplierCostBasis === "CATALOG_MINIMUM"
  ) {
    partial.push(
      "Supplier cost is a reference value rather than the definitive cost of a resolved variant.",
    );
  }

  if (input.feeResult.status === "INCOMPLETE") {
    partial.push("The fee rule is incomplete for this listing.");
  }

  if (input.buyerShippingCents === null) {
    partial.push(
      "eBay returned no priced shipping option for this listing, so buyer-paid shipping is treated as $0.00 and the fee basis is the item price only.",
    );
  }

  if (currency.assumed) {
    partial.push(
      "The listing carries no currency code; USD is assumed because the supplier side is USD.",
    );
  }

  if (partial.length > 0) {
    return { completeness: "PARTIAL", reasons: partial };
  }

  return { completeness: "COMPLETE", reasons: [] };
}

/**
 * Computes the full economics result. Pure: identical inputs ⇒ identical output.
 *
 * When completeness is `UNAVAILABLE`, `estimatedProfit` and `marginPercent` are
 * `null` — this function never manufactures a profit from missing components.
 */
export function computeEconomics(input: EconomicsInput): EconomicsResult {
  const currency = resolveCurrency(input.currency);
  const { completeness, reasons } = evaluateCompleteness(input);

  const itemPrice =
    input.itemPriceCents === null ? null : formatCents(input.itemPriceCents);
  const buyerShipping =
    input.buyerShippingCents === null
      ? null
      : formatCents(input.buyerShippingCents);

  const revenueCents = sumCents([input.itemPriceCents, input.buyerShippingCents]);
  const grossMarketplaceRevenue = revenueCents > 0 ? formatCents(revenueCents) : null;

  const supplierProductCost =
    input.supplierProductCostCents === null
      ? null
      : formatCents(input.supplierProductCostCents);

  const shippingCents =
    input.selectedQuote === null ? null : parseDecimalToCents(input.selectedQuote.cost);
  const supplierShippingCost = shippingCents === null ? null : formatCents(shippingCents);

  const landedCents = sumCents([input.supplierProductCostCents, shippingCents]);
  // Landed cost is only meaningful when both supplier components are known;
  // a landed cost without shipping is not a landed cost.
  const landedSupplierCost =
    input.supplierProductCostCents !== null && shippingCents !== null
      ? formatCents(landedCents)
      : null;

  const feeCents = parseDecimalToCents(input.feeResult.total);

  // Profit is only computed when every component exists; otherwise it stays
  // honestly null instead of being partially summed.
  const canComputeProfit =
    completeness !== "UNAVAILABLE" &&
    revenueCents > 0 &&
    feeCents !== null;

  const profitCents = canComputeProfit ? revenueCents - landedCents - feeCents : null;
  const estimatedProfit = profitCents === null ? null : formatCents(profitCents);

  const marginPercentCents =
    profitCents === null ? null : percentRatioCents(profitCents, revenueCents);
  const marginPercent =
    marginPercentCents === null ? null : formatCents(marginPercentCents);

  // Completeness reasons are always surfaced: a PARTIAL figure needs its
  // caveats next to it, and an UNAVAILABLE result is useless to an operator
  // unless it says which component was missing.
  const warnings = [...input.inputWarnings, ...reasons];

  const assumptions = [
    "Economics model a single-unit order (quantity 1).",
    "CJ publishes supplier costs and shipping quotes in USD; all supplier amounts are treated as USD.",
    `Shipping is quoted to the baseline destination (${input.shippingDestination.label}) and is not a universal shipping guarantee.`,
    "Marketplace fees are Inkora's rule-based estimate, not an exact eBay charge.",
  ];

  // A reference or catalogue-minimum cost is not an authoritative CJ figure, so
  // only a resolved-variant cost earns OFFICIAL provenance.
  const supplierProductCostProvenance: Provenance =
    input.supplierCostBasis === "SELECTED_VARIANT" ? "OFFICIAL" : "ESTIMATED";

  const provenance: EconomicsProvenance = {
    itemPrice: "OFFICIAL",
    buyerShipping: input.buyerShippingCents === null ? "ESTIMATED" : "OFFICIAL",
    supplierProductCost: supplierProductCostProvenance,
    supplierShippingCost: "OFFICIAL",
    marketplaceFee: "ESTIMATED",
    estimatedProfit: "ESTIMATED",
    marginPercent: "ESTIMATED",
  };

  return {
    marketplace: "ebay",
    marketplaceItemId: input.marketplaceItemId,
    itemPrice,
    buyerShipping,
    grossMarketplaceRevenue,
    currency: currency.code,

    supplier: "cj",
    supplierProductId: input.supplierProductId,
    selectedVariant: input.selectedVariant,
    supplierProductCost,
    supplierCostBasis: input.supplierCostBasis,
    supplierShippingCost,
    supplierShippingMethod: input.selectedQuote?.method ?? null,
    supplierShippingTransitTime: input.selectedQuote?.transitTime ?? null,
    shippingQuotes: input.shippingQuotes,
    shippingDestination: input.shippingDestination,
    landedSupplierCost,

    marketplaceFee: input.feeResult.total,
    feeBreakdown: input.feeResult.breakdown,
    feeEngineVersion: input.feeResult.engineVersion,
    feeStatus: input.feeResult.status,
    feeRuleSource: input.feeResult.ruleSource,

    estimatedProfit,
    marginPercent,

    completeness,
    economicsEngineVersion: ECONOMICS_ENGINE_VERSION,
    provenance,
    assumptions,
    warnings,
    calculatedAt: input.calculatedAt,
  };
}
