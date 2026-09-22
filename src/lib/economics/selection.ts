/**
 * Deterministic selection policies for economics.
 *
 * Both decisions the economics engine has to make — *which supplier variant*
 * and *which shipping quote* — are pure functions here rather than inline logic,
 * so they are unit-testable without any network access and are identical on
 * every run (docs/ARCHITECTURE.md §10.2).
 *
 * These are deliberately *policies*, not optimizers: they resolve a single,
 * documented choice and surface the caveat when the choice is not definitive.
 */

import type { ShippingQuote, SupplierVariant } from "@/lib/supplier/types";
import type { SupplierCostBasis } from "./types";
import { parseDecimalToCents } from "./money";

/** The variant the economics will be computed for, and what its cost means. */
export interface VariantSelection {
  variant: SupplierVariant;
  basis: SupplierCostBasis;
  /** Why this variant was chosen, in human-readable form. */
  note: string;
  /** Caveats the caller must surface (for example: cost is a reference). */
  warnings: string[];
}

/**
 * A variant is usable for economics only if it carries an id and a real price.
 * Anything else cannot be quoted or costed, and is excluded rather than guessed.
 */
function eligibleVariants(variants: SupplierVariant[]): SupplierVariant[] {
  return variants.filter((variant) => {
    if (!variant.externalId) return false;
    const cents = parseDecimalToCents(variant.price);
    return cents !== null && cents > 0;
  });
}

function variantCostCents(variant: SupplierVariant): number | null {
  return parseDecimalToCents(variant.price);
}

function stockedInDestination(
  variant: SupplierVariant,
  destinationCountry: string,
): boolean {
  return (variant.warehouseCountries ?? []).includes(destinationCountry);
}

/**
 * Selects the supplier variant to cost and quote shipping for.
 *
 * Policy, in order:
 * 1. Keep only variants with an id and a positive price.
 * 2. One eligible variant → it is the selection, definitively.
 * 3. Several eligible variants with identical pricing → cost is unambiguous, so
 *    the selection is definitive (`SELECTED_VARIANT`).
 * 4. Otherwise identity cannot be resolved from the marketplace listing, so a
 *    deterministic *reference* is chosen — preferring a variant stocked in the
 *    destination country, then the lowest cost — and the basis is
 *    `VARIANT_REFERENCE`: the cost is a lower bound, never the definitive cost.
 *
 * Returns `null` when no usable variant exists, which the caller reports as
 * "variant unresolved" rather than costing the product anyway.
 */
export function selectSupplierVariant(
  variants: SupplierVariant[],
  destinationCountry: string,
): VariantSelection | null {
  const eligible = eligibleVariants(variants);
  if (eligible.length === 0) {
    return null;
  }

  if (eligible.length === 1) {
    return {
      variant: eligible[0],
      basis: "SELECTED_VARIANT",
      note: "The supplier product has a single variant, so its cost is definitive.",
      warnings: [],
    };
  }

  const costs = eligible.map(variantCostCents);
  const uniform = costs.every((value) => value === costs[0]);
  if (uniform) {
    return {
      variant: rankedFirst(eligible, destinationCountry),
      basis: "SELECTED_VARIANT",
      note: `The supplier product has ${eligible.length} variants, all priced identically, so the cost is unambiguous.`,
      warnings: [],
    };
  }

  const ranked = rankedFirst(eligible, destinationCountry);
  const stocked = stockedInDestination(ranked, destinationCountry);
  return {
    variant: ranked,
    basis: "VARIANT_REFERENCE",
    note: `The supplier product has ${eligible.length} variants with different costs, and the marketplace listing does not identify which one it is. The lowest-cost variant${stocked ? " with confirmed destination-country stock" : ""} is used as a reference.`,
    warnings: [
      "Variant identity is not resolved: supplier cost is a reference lower bound, not the definitive cost of the listed item.",
      ...(stocked
        ? []
        : ["No variant with confirmed stock in the destination country was found; fulfillment may ship from another warehouse."]),
    ],
  };
}

/** Deterministic tie-break ordering used by every selection path. */
function rankedFirst(
  variants: SupplierVariant[],
  destinationCountry: string,
): SupplierVariant {
  return [...variants].sort((a, b) => {
    const aStocked = stockedInDestination(a, destinationCountry) ? 0 : 1;
    const bStocked = stockedInDestination(b, destinationCountry) ? 0 : 1;
    if (aStocked !== bStocked) return aStocked - bStocked;

    const aCost = variantCostCents(a) ?? Number.POSITIVE_INFINITY;
    const bCost = variantCostCents(b) ?? Number.POSITIVE_INFINITY;
    if (aCost !== bCost) return aCost - bCost;

    return String(a.externalId).localeCompare(String(b.externalId));
  })[0];
}


/** A quote is usable when it names a method and prices it. */
function eligibleQuotes(quotes: ShippingQuote[]): ShippingQuote[] {
  return quotes.filter((quote) => {
    if (!quote.method.trim()) return false;
    const cents = parseDecimalToCents(quote.cost);
    return cents !== null && cents >= 0;
  });
}

function quoteCostCents(quote: ShippingQuote): number {
  return parseDecimalToCents(quote.cost) ?? 0;
}

function hasTransitTime(quote: ShippingQuote): boolean {
  return quote.transitTime !== null && quote.transitTime.trim().length > 0;
}

/**
 * Selects one shipping quote from the supplier's response.
 *
 * Policy (docs/ARCHITECTURE.md §10.2): keep quotes that name a method and price
 * it; prefer a quote that documents its delivery time; then take the lowest
 * cost. Ties break on the method name, so the result is fully deterministic.
 *
 * Returns `null` when no quote is usable — the caller must then leave economics
 * incomplete rather than substituting an assumed shipping cost.
 */
export function selectShippingQuote(
  quotes: ShippingQuote[],
): ShippingQuote | null {
  const eligible = eligibleQuotes(quotes);
  if (eligible.length === 0) return null;

  return [...eligible].sort((a, b) => {
    if (hasTransitTime(a) !== hasTransitTime(b)) {
      return hasTransitTime(a) ? -1 : 1;
    }
    if (quoteCostCents(a) !== quoteCostCents(b)) {
      return quoteCostCents(a) - quoteCostCents(b);
    }
    return a.method.localeCompare(b.method);
  })[0];
}
