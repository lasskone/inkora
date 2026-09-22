/**
 * Deterministic, versionable eBay fee engine.
 *
 * The fee engine is deliberately a *rule set*, not a hardcoded percentage: it
 * carries a version, a documented source, and the list of components it applied,
 * so any fee Inkora surfaces can be audited and later recomputed when the rules
 * change (docs/ARCHITECTURE.md §6.2 and §9).
 *
 * What V1 models (United States, eBay.com, managed payments):
 *
 * - **Final value fee** — a single rate on the *total amount of the sale*, with a
 *   per-order minimum. The total sale amount is modeled as the item price plus
 *   the buyer-paid shipping charge.
 * - **Insertion (listing) fee** — modeled at zero under the documented
 *   assumption that the listing falls inside eBay's free monthly allotment.
 *
 * What V1 intentionally does **not** model, and says so in every result:
 *
 * - Seller-subscription effects. eBay Store subscribers pay different rates.
 *   INKORA cannot observe the seller's subscription, so the standard
 *   (non-Store) rate is used and the fee is always `ESTIMATED`, never `EXACT`.
 * - Sales tax / VAT on the fee basis. eBay's fee applies to the total sale
 *   amount *including* applicable taxes; tax is not available to INKORA, so the
 *   modeled fee can understate the real charge.
 * - Per-category final-value-fee maximums. The authoritative category cap table
 *   could not be validated from the official documentation available to this
 *   project, so no cap is invented. Where a cap would apply, the real fee is
 *   *lower* than this estimate.
 * - Optional listing upgrades (subtitle, gallery plus, reserve price, …),
 *   which are seller-elected and not observable from listing data.
 *
 * Category-specific rules are *structured for* (the engine accepts category ids
 * and resolves them through a rule table) even though V1's table only carries
 * the general default — the seam is intentional, not an omission.
 *
 * This module is pure: given the same inputs and the same rule version it always
 * returns the same result, with no I/O and no `server-only` import.
 */

import type { FeeBreakdownComponent, FeeCalculationStatus, FeeResult } from "./types";
import { formatCents, percentOfCents, sumCents } from "./money";

/**
 * Fee-engine version. Bumped whenever a rule (rate, minimum, component set, or
 * fee basis) changes, so a stored result can always be tied back to its rules.
 */
export const FEE_ENGINE_VERSION = "ebay-us-1.0";

/**
 * Where the rules come from. Surfaced in every result alongside the version.
 */
export const FEE_RULE_SOURCE =
  "eBay published US selling-fee policy for standard (non-Store) sellers, modeled by Inkora";

/** Final value fee rate, in basis points. 1325 = 13.25%. */
const FINAL_VALUE_RATE_BPS = 1325;

/** eBay's per-order minimum final value fee, in minor units ($0.30). */
const FINAL_VALUE_MINIMUM_CENTS = 30;

/** Free monthly insertion allotment assumed by the model. */
const FREE_INSERTION_ALLOTMENT = 250;

/** Human-readable rate, for the breakdown. */
const RATE_LABEL = (FINAL_VALUE_RATE_BPS / 100).toFixed(4);

/**
 * Category-specific fee overrides. V1 intentionally contains only the general
 * default: no category cap could be validated against official documentation, so
 * none is asserted. New rows land here as they are verified.
 */
interface CategoryFeeRule {
  /** Final value fee rate for this category, in basis points. */
  rateBps: number;
  /** Per-order minimum, in minor units. */
  minimumCents: number;
  /** Documented maximum fee for the category, in minor units, when verified. */
  maximumCents: number | null;
}

const DEFAULT_FEE_RULE: CategoryFeeRule = {
  rateBps: FINAL_VALUE_RATE_BPS,
  minimumCents: FINAL_VALUE_MINIMUM_CENTS,
  maximumCents: null,
};

const CATEGORY_FEE_RULES: Record<string, CategoryFeeRule> = {};

function resolveCategoryRule(categoryIds: string[] | undefined): CategoryFeeRule {
  if (categoryIds) {
    for (const id of categoryIds) {
      const rule = CATEGORY_FEE_RULES[id.trim()];
      if (rule) return rule;
    }
  }
  return DEFAULT_FEE_RULE;
}

/** Inputs the fee engine needs. All money is in minor units (cents). */
export interface EbayFeeInput {
  itemPriceCents: number | null;
  buyerShippingCents: number | null;
  currency: string | null;
  /** eBay category ids from the listing, when available. */
  categoryIds?: string[];
}


/**
 * Calculates the eBay marketplace fee for one order.
 *
 * Deterministic and total: same inputs + this rule version ⇒ identical output.
 * The result always carries its caveats, because an estimated fee must never be
 * presented as an exact eBay charge.
 */
export function calculateEbayFees(input: EbayFeeInput): FeeResult {
  const rule = resolveCategoryRule(input.categoryIds);
  const caveats = buildCaveats(rule);

  const itemPrice = input.itemPriceCents;

  // Without a sale price there is no sale to fee. The result is INCOMPLETE, and
  // no fee amount is fabricated.
  if (itemPrice === null || itemPrice <= 0) {
    return incomplete(input, caveats, itemPrice);
  }

  // Buyer-paid shipping is part of eBay's total-sale-amount basis. When eBay did
  // not price a shipping option, the basis is the item price alone — a stated
  // assumption, never a silent zero treated as profit.
  const basis = itemPrice + (input.buyerShippingCents ?? 0);

  let finalValueCents = percentOfCents(basis, rule.rateBps);
  if (finalValueCents < rule.minimumCents) {
    finalValueCents = rule.minimumCents;
  }

  const insertionCents = 0;
  const total = sumCents([finalValueCents, insertionCents]);

  const breakdown: FeeBreakdownComponent[] = [
    {
      name: "finalValueFee",
      label: "Final value fee",
      amount: formatCents(finalValueCents),
      rate: RATE_LABEL,
      status: "ESTIMATED",
      note: `${RATE_LABEL} of the total sale amount (item price + buyer shipping)${rule.maximumCents !== null ? `, capped at ${formatCents(rule.maximumCents)}` : ""}, minimum ${formatCents(rule.minimumCents)} per order.`,
    },
    {
      name: "insertionFee",
      label: "Insertion (listing) fee",
      amount: formatCents(insertionCents),
      rate: null,
      status: "ESTIMATED",
      note: `Assumed $0.00 — the listing is within eBay's free allotment of ${FREE_INSERTION_ALLOTMENT} listings per month. Listings beyond the allotment are charged per listing.`,
    },
  ];

  return {
    total: formatCents(total),
    currency: input.currency,
    breakdown,
    status: "ESTIMATED",
    engineVersion: FEE_ENGINE_VERSION,
    ruleSource: FEE_RULE_SOURCE,
    feeBasis: formatCents(basis),
    caveats,
    provenance: "ESTIMATED",
  };
}

function buildCaveats(rule: CategoryFeeRule): string[] {
  const caveats = [
    `Rule-based estimate (${FEE_ENGINE_VERSION}), not an exact eBay charge. The rate assumes a standard seller account; eBay Store subscribers pay different rates INKORA cannot observe.`,
    `eBay applies the final value fee to the total sale amount including applicable taxes. Tax is unavailable to INKORA, so this estimate may understate the real fee.`,
  ];
  if (rule.maximumCents === null) {
    caveats.push(
      "Per-category final-value-fee maximums are not modeled. Where a cap would apply, the real fee is lower than this estimate.",
    );
  }
  caveats.push(
    `Insertion fee assumes the listing is within eBay's free ${FREE_INSERTION_ALLOTMENT}-listing monthly allotment; excess listings are charged per listing.`,
  );
  return caveats;
}

function incomplete(
  input: EbayFeeInput,
  caveats: string[],
  itemPrice: number | null,
): FeeResult {
  const status: FeeCalculationStatus = "INCOMPLETE";
  const reason =
    itemPrice === null
      ? "No marketplace sale price is available, so no fee can be calculated."
      : "The marketplace sale price is not positive, so no fee applies.";

  return {
    total: null,
    currency: input.currency,
    breakdown: [
      {
        name: "finalValueFee",
        label: "Final value fee",
        amount: null,
        rate: RATE_LABEL,
        status,
        note: reason,
      },
    ],
    status,
    engineVersion: FEE_ENGINE_VERSION,
    ruleSource: FEE_RULE_SOURCE,
    feeBasis: null,
    caveats,
    provenance: "ESTIMATED",
  };
}
