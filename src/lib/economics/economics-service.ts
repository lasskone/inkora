import "server-only";

import { requireCjConfig } from "@/lib/cj/config";
import { quoteCjShipping } from "@/lib/cj/shipping";
import { calculateEbayFees } from "./fee-engine";
import { computeEconomics } from "./calculate";
import { parseDecimalToCents } from "./money";
import type { EconomicsResult } from "./types";
import type { ShippingBaseline } from "./config";
import type { MatchCandidate } from "@/lib/matcher/types";
import type { SupplierVariant } from "@/lib/supplier/types";

/**
 * Server-side economics orchestration (docs/ARCHITECTURE.md §10).
 *
 * This module is the *only* place that mixes external acquisition with
 * calculation. It:
 *
 *   1. resolves the supplier variant and the shipping quote through the isolated
 *      CJ shipping service (never inline in the UI, never inside a formula);
 *   2. hands the parsed values to the pure fee engine and the pure economics
 *      calculation, which produce the auditable result.
 *
 * Every value the browser receives is rebuilt here from authoritative upstream
 * sources — the client never supplies a price, a cost, or a shipping figure.
 */

export interface EconomicsRequest {
  /** The validated matcher candidate to economics. */
  candidate: MatchCandidate;
  /** Documented baseline destination (see ./config). */
  destination: ShippingBaseline;
  /** Order size quoted; V1 economics model a single-unit order. */
  quantity?: number;
}

export interface EconomicsOutcome {
  result: EconomicsResult;
  /** Matcher confidence of the candidate, for the low-confidence caveat. */
  matchConfidence: number;
  matchConfidenceBand: MatchCandidate["confidenceBand"];
  /**
   * The supplier variant the cost was resolved for, or `null` when variants
   * could not be resolved (in which case `result.supplierCostBasis` reflects the
   * catalogue fallback). Carried through to persistence.
   */
  selectedVariant: SupplierVariant | null;
}

/**
 * Computes economics for one human-selected matcher candidate.
 *
 * The caller is responsible for guaranteeing `candidate` really is a matcher
 * candidate for the listing (the API route re-runs the bounded matcher to prove
 * it) — economics are never computed for an arbitrary supplier id.
 */
export async function computeCandidateEconomics(
  request: EconomicsRequest,
): Promise<EconomicsOutcome> {
  const config = requireCjConfig();
  const { candidate, destination } = request;
  const marketplace = candidate.marketplaceProduct;
  const supplier = candidate.supplierProduct;

  const shipping = await quoteCjShipping(config, {
    pid: supplier.externalId,
    destinationCountry: destination.countryCode,
    destinationPostalCode: destination.postalCode,
    quantity: request.quantity ?? 1,
  });

  const warnings = [...shipping.notes];

  // --- Supplier cost: prefer the resolved variant; fall back to the catalogue
  // price, clearly labelled as a lower bound rather than a definitive cost.
  let supplierProductCostCents: number | null = null;
  let supplierCostBasis = shipping.selectedVariant?.basis ?? null;

  if (shipping.selectedVariant !== null) {
    supplierProductCostCents = parseDecimalToCents(
      shipping.selectedVariant.variant.price,
    );
  } else {
    supplierProductCostCents = parseDecimalToCents(supplier.supplierPrice);
    supplierCostBasis = "CATALOG_MINIMUM";
    warnings.push(
      "Supplier cost falls back to the catalogue-level price (a lower bound) because the product's variants could not be resolved.",
    );
  }

  const itemPriceCents = parseDecimalToCents(marketplace.price);
  const buyerShippingCents = parseDecimalToCents(marketplace.shippingCost);

  const feeResult = calculateEbayFees({
    itemPriceCents,
    buyerShippingCents,
    currency: marketplace.currency,
  });

  const result = computeEconomics({
    marketplaceItemId: marketplace.externalId,
    itemPriceCents,
    buyerShippingCents,
    currency: marketplace.currency,
    supplierProductId: supplier.externalId,
    selectedVariant:
      shipping.selectedVariant === null
        ? null
        : {
            externalId: shipping.selectedVariant.variant.externalId as string,
            sku: shipping.selectedVariant.variant.sku,
            title: shipping.selectedVariant.variant.title,
          },
    supplierProductCostCents,
    supplierCostBasis,
    shippingQuotes: shipping.quotes,
    selectedQuote: shipping.selectedQuote,
    shippingDestination: {
      countryCode: destination.countryCode,
      postalCode: destination.postalCode,
      label: destination.label,
    },
    feeResult,
    inputWarnings: warnings,
    calculatedAt: new Date().toISOString(),
  });

  return {
    result,
    matchConfidence: candidate.confidence,
    matchConfidenceBand: candidate.confidenceBand,
    selectedVariant: shipping.selectedVariant?.variant ?? null,
  };
}
