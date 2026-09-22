/**
 * Provider-independent economics result model.
 *
 * The economics engine composes an auditable profit figure from explicitly
 * separated components — marketplace revenue, buyer-paid shipping, supplier
 * product cost, supplier shipping cost, and marketplace fees — and never folds
 * them into one opaque score (see docs/ARCHITECTURE.md §6.3 and §10).
 *
 * This module is pure type declarations on purpose (no `server-only`, no runtime
 * imports) so the deterministic calculation functions are unit-testable with
 * Node's built-in runner and the same shapes serve the browser UI.
 */

import type { Provenance } from "@/lib/marketplace/types";
import type { ShippingQuote } from "@/lib/supplier/types";

/**
 * How complete an economics result is. A result is never `COMPLETE` unless
 * every component actionable profit requires is actually present
 * (see `evaluateCompleteness`).
 *
 * - COMPLETE   — profit and margin are computable from sufficiently
 *                authoritative inputs.
 * - PARTIAL    — profit is computable, but a component is non-definitive or a
 *                documented caveat applies (for example the supplier variant
 *                could not be resolved, so cost is a reference value).
 * - UNAVAILABLE— a required component is missing, so no profit figure is
 *                produced at all.
 */
export type EconomicsCompleteness = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

/**
 * What the supplier product cost actually represents. This distinction is the
 * difference between a defensible profit figure and a fabricated one
 * (docs/ARCHITECTURE.md §10.3):
 *
 * - SELECTED_VARIANT   — the cost of a specific, unambiguously identified
 *                        supplier variant. Definitive.
 * - VARIANT_REFERENCE  — multiple variants exist and identity could not be
 *                        resolved from the marketplace listing, so a
 *                        deterministic reference variant was used. Its cost is
 *                        a *reference*, not the definitive cost.
 * - CATALOG_MINIMUM    — only catalogue-level pricing was obtainable (no
 *                        variant detail). A lower bound, never definitive.
 */
export type SupplierCostBasis =
  | "SELECTED_VARIANT"
  | "VARIANT_REFERENCE"
  | "CATALOG_MINIMUM";

/**
 * Fee-quality classification, following the project's "never fabricate
 * precision" rule (docs/ARCHITECTURE.md §7):
 *
 * - EXACT     — the marketplace asserts this charge directly.
 * - ESTIMATED — a deterministic Inkora rule produced it from published policy;
 *               it is *not* an exact marketplace charge.
 * - INCOMPLETE— the rule could not be applied because a required input (for
 *               example the sale price) is missing.
 *
 * V1 never emits `EXACT`: eBay does not tell Inkora the seller's subscription
 * level, so every fee here is a rule-based estimate.
 */
export type FeeCalculationStatus = "EXACT" | "ESTIMATED" | "INCOMPLETE";

/** One named component of the marketplace fee breakdown. */
export interface FeeBreakdownComponent {
  /** Stable machine name, e.g. `finalValueFee`. */
  name: string;
  /** Human-readable label, e.g. `Final value fee`. */
  label: string;
  /** Amount as a decimal string, or `null` when this component cannot be computed. */
  amount: string | null;
  /** The rate applied, as a decimal string (e.g. `0.1325`), when the rule is rate-based. */
  rate: string | null;
  /** Whether this component is an exact charge or an Inkora rule-based estimate. */
  status: FeeCalculationStatus;
  /** Why the amount is what it is, in human-readable form. */
  note: string;
}

/** The full marketplace-fee verdict for one order. */
export interface FeeResult {
  /** Total marketplace fee as a decimal string, or `null` when it cannot be computed. */
  total: string | null;
  currency: string | null;
  breakdown: FeeBreakdownComponent[];
  status: FeeCalculationStatus;
  /** Version of the fee-rule set that produced this result. */
  engineVersion: string;
  /** Documented source/context of the rules applied. */
  ruleSource: string;
  /** The amount the fee was computed on, as a decimal string. */
  feeBasis: string | null;
  /**
   * Caveats an operator must see alongside the number. Always non-empty for an
   * `ESTIMATED` fee — an estimated fee is never presented without its caveats.
   */
  caveats: string[];
  /** Fees are derived by Inkora, never asserted by eBay. Always `ESTIMATED`. */
  provenance: Extract<Provenance, "ESTIMATED">;
}

/** The shipping destination a quote was computed for. */
export interface ShippingDestination {
  /** ISO 3166-1 alpha-2 country code, e.g. `US`. */
  countryCode: string;
  /** Postal code when one was sent to the supplier, else `null`. */
  postalCode: string | null;
  /** Human-readable label for the UI, e.g. `United States (baseline destination)`. */
  label: string;
}


/**
 * The economics engine's complete, self-explanatory result.
 */
export interface EconomicsResult {
  // --- Marketplace revenue side -------------------------------------------
  marketplace: "ebay";
  marketplaceItemId: string;
  /** eBay item (listing) price, decimal string, or `null` when not returned. */
  itemPrice: string | null;
  /** eBay buyer-paid shipping charge, decimal string, or `null` when not priced. */
  buyerShipping: string | null;
  /** Item price plus buyer-paid shipping. `null` when neither is present. */
  grossMarketplaceRevenue: string | null;
  /** ISO 4217 currency of the marketplace amounts, when known. */
  currency: string | null;

  // --- Supplier cost side --------------------------------------------------
  supplier: "cj";
  supplierProductId: string;
  /** The variant the quote and cost were resolved for, when one was resolved. */
  selectedVariant: {
    /** Supplier variant id (CJ `vid`). */
    externalId: string;
    sku: string | null;
    title: string | null;
  } | null;
  /** Supplier product cost, decimal string, or `null` when unavailable. */
  supplierProductCost: string | null;
  /** What `supplierProductCost` represents — definitive vs. reference. */
  supplierCostBasis: SupplierCostBasis | null;
  /** Selected supplier shipping cost, decimal string, or `null` when no quote. */
  supplierShippingCost: string | null;
  /** Carrier/method name of the selected quote, e.g. `USPS+`. */
  supplierShippingMethod: string | null;
  /** Supplier-reported transit-time range of the selected quote (e.g. `2-5`). */
  supplierShippingTransitTime: string | null;
  /** Every quote the supplier returned, kept for transparency. */
  shippingQuotes: ShippingQuote[];
  shippingDestination: ShippingDestination;
  /** Supplier product cost plus selected supplier shipping cost. */
  landedSupplierCost: string | null;

  // --- Fees ----------------------------------------------------------------
  /** Total marketplace fee, decimal string, or `null` when not computable. */
  marketplaceFee: string | null;
  feeBreakdown: FeeBreakdownComponent[];
  feeEngineVersion: string;
  feeStatus: FeeCalculationStatus;
  feeRuleSource: string;

  // --- Result --------------------------------------------------------------
  /** Estimated profit, decimal string, or `null` when economics are incomplete. */
  estimatedProfit: string | null;
  /** Estimated margin as a percentage string (e.g. `12.34`), or `null`. */
  marginPercent: string | null;

  completeness: EconomicsCompleteness;
  /** Per-component provenance — derived values are never labelled official. */
  provenance: EconomicsProvenance;
  /** Stated assumptions the figures depend on. */
  assumptions: string[];
  /** Warnings that must be surfaced before the figures are relied on. */
  warnings: string[];
  /** ISO 8601 UTC timestamp of the calculation. */
  calculatedAt: string;
}

/**
 * Provenance of each economic component, expressed with the project's existing
 * categories (docs/ARCHITECTURE.md §7) rather than redefining them.
 */
export interface EconomicsProvenance {
  /** eBay listing price — `OFFICIAL` (eBay API). */
  itemPrice: Provenance;
  /** Buyer-paid shipping — `OFFICIAL` when eBay priced it, else `null`. */
  buyerShipping: Provenance;
  /** CJ supplier cost — `OFFICIAL` (CJ API). */
  supplierProductCost: Provenance;
  /** CJ shipping quote — `OFFICIAL` (CJ freight API). */
  supplierShippingCost: Provenance;
  /** Fee — always `ESTIMATED`: an Inkora rule over published policy. */
  marketplaceFee: Extract<Provenance, "ESTIMATED">;
  /** Profit — always `ESTIMATED`: derived. */
  estimatedProfit: Extract<Provenance, "ESTIMATED">;
  /** Margin — always `ESTIMATED`: derived. */
  marginPercent: Extract<Provenance, "ESTIMATED">;
}
