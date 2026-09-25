/**
 * Deterministic change summary for Product Detail (docs/ARCHITECTURE.md
 * §18.4, §16.8 — the same rules the watchlist comparison applies).
 *
 * This is a *previous vs current* comparison over two persisted observations —
 * never a trend, never growth, never momentum. Two points cannot establish a
 * direction of travel, and this module never implies they can.
 *
 * Standing rules, all pinned by tests:
 *
 *   - A field present on only one side is `direction: "unknown"` with a `null`
 *     delta. Missing data is never interpreted as "unchanged".
 *   - Money is normalized to integer minor units before subtraction and
 *     formatted back, so no binary float ever participates in arithmetic
 *     (docs/DATABASE.md §8).
 *   - A negative profit stays negative and a negative delta is reported `down`;
 *     nothing is clamped or hidden.
 *   - Categorical fields render `previous → current` with an explicit
 *     `changed` flag.
 */

import { formatCents, parseDecimalToCents } from "@/lib/economics/money";
import type { EconomicsObservationHistoryEntry } from "@/types/product-history";
import type { MarketplaceSnapshotHistoryEntry } from "@/types/product-history";
import type { MatchObservationHistoryEntry } from "@/types/product-history";
import type {
  AssessmentHistoryEntry,
  ChangeRow,
  ChangeSummary,
} from "./types";

/**
 * One field the summary knows how to compare. Money fields are compared in
 * integer minor units; everything else is categorical.
 */
interface ComparableMoney {
  kind: "money";
  field: string;
  label: string;
  previous: string | null;
  current: string | null;
}

interface ComparableCategory {
  kind: "category";
  field: string;
  label: string;
  previous: string | null;
  current: string | null;
}

type Comparable = ComparableMoney | ComparableCategory;

/** Hours between two ISO timestamps; `null` when either side is unusable. */
export function elapsedHours(
  earlier: string | null,
  later: string | null,
): number | null {
  if (earlier === null || later === null) {
    return null;
  }
  const a = Date.parse(earlier);
  const b = Date.parse(later);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return null;
  }
  return (b - a) / 3_600_000;
}

/** Subtracts two decimal-string money values, returning a formatted delta. */
function moneyDelta(previous: string | null, current: string | null): string | null {
  if (previous === null || current === null) {
    return null;
  }
  const a = parseDecimalToCents(previous);
  const b = parseDecimalToCents(current);
  if (a === null || b === null) {
    return null;
  }
  return formatCents(b - a);
}

/** Direction of a numeric comparison; `unknown` when either side is missing. */
function moneyDirection(
  previous: string | null,
  current: string | null,
  delta: string | null,
): ChangeRow["direction"] {
  if (previous === null || current === null || delta === null) {
    return "unknown";
  }
  const value = parseDecimalToCents(delta);
  if (value === null) {
    return "unknown";
  }
  if (value > 0) {
    return "up";
  }
  if (value < 0) {
    return "down";
  }
  return "unchanged";
}

/** Renders one comparable field into a change row. */
function toRow(comparable: Comparable): ChangeRow {
  if (comparable.kind === "category") {
    const changed =
      comparable.previous !== null &&
      comparable.current !== null &&
      comparable.previous !== comparable.current;
    return {
      field: comparable.field,
      label: comparable.label,
      previous: comparable.previous,
      current: comparable.current,
      delta: null,
      // A category with one side missing is not "unchanged" — it is unknown.
      direction:
        comparable.previous === null || comparable.current === null
          ? "unknown"
          : changed
            ? "up"
            : "unchanged",
    };
  }

  const delta = moneyDelta(comparable.previous, comparable.current);
  return {
    field: comparable.field,
    label: comparable.label,
    previous: comparable.previous,
    current: comparable.current,
    delta,
    direction: moneyDirection(comparable.previous, comparable.current, delta),
  };
}


/**
 * Builds the deterministic change summary from the two most recent persisted
 * observations of each kind.
 *
 * Every input is already most-recent-first, so `[0]` is the current observation
 * and `[1]` is the immediately previous one. An absent `[1]` means this is the
 * first observation, which the summary states rather than dressing up as "no
 * change".
 */
export function buildChangeSummary(params: {
  marketplaceSnapshots: MarketplaceSnapshotHistoryEntry[];
  economicsObservations: EconomicsObservationHistoryEntry[];
  matchObservations: MatchObservationHistoryEntry[];
  assessments: AssessmentHistoryEntry[];
  /** Supplier stock availability at each observation, newest first. */
  supplierStock: Array<{ availableInventory: number | null; observedAt: string | null }>;
}): ChangeSummary {
  const current = params.assessments[0] ?? null;
  const previousAssessment = params.assessments[1] ?? null;

  const currentMarket = params.marketplaceSnapshots[0] ?? null;
  const previousMarket = params.marketplaceSnapshots[1] ?? null;

  const currentEconomics = params.economicsObservations[0] ?? null;
  const previousEconomics = params.economicsObservations[1] ?? null;

  const currentMatch = params.matchObservations[0] ?? null;
  const previousMatch = params.matchObservations[1] ?? null;

  const currentStock = params.supplierStock[0] ?? null;
  const previousStock = params.supplierStock[1] ?? null;

  const comparables: Comparable[] = [
    {
      kind: "money",
      field: "marketplacePrice",
      label: "Marketplace price",
      previous: previousMarket?.price ?? null,
      current: currentMarket?.price ?? null,
    },
    {
      kind: "money",
      field: "buyerShipping",
      label: "Buyer-paid shipping",
      previous: previousMarket?.shippingCost ?? null,
      current: currentMarket?.shippingCost ?? null,
    },
    {
      kind: "money",
      field: "supplierProductCost",
      label: "Supplier product cost",
      previous: previousEconomics?.supplierProductCost ?? null,
      current: currentEconomics?.supplierProductCost ?? null,
    },
    {
      kind: "money",
      field: "landedCost",
      label: "Landed cost",
      previous: previousEconomics?.landedCost ?? null,
      current: currentEconomics?.landedCost ?? null,
    },
    {
      kind: "money",
      field: "marketplaceFee",
      label: "Marketplace fee",
      previous: previousEconomics?.marketplaceFee ?? null,
      current: currentEconomics?.marketplaceFee ?? null,
    },
    {
      kind: "money",
      field: "estimatedProfit",
      label: "Estimated profit",
      previous: previousEconomics?.estimatedProfit ?? null,
      current: currentEconomics?.estimatedProfit ?? null,
    },
    {
      kind: "money",
      field: "marginPercent",
      label: "Margin",
      previous: previousEconomics?.marginPercent ?? null,
      current: currentEconomics?.marginPercent ?? null,
    },
    {
      kind: "money",
      field: "opportunityScore",
      label: "Opportunity score",
      previous: previousAssessment === null ? null : String(previousAssessment.score),
      current: current === null ? null : String(current.score),
    },
    {
      kind: "money",
      field: "evidenceConfidence",
      label: "Evidence confidence",
      previous: previousAssessment === null ? null : String(previousAssessment.confidence),
      current: current === null ? null : String(current.confidence),
    },
    {
      kind: "money",
      field: "matchConfidence",
      label: "Match confidence",
      previous: previousMatch === null ? null : String(previousMatch.confidence),
      current: currentMatch === null ? null : String(currentMatch.confidence),
    },
    {
      kind: "category",
      field: "scoreBand",
      label: "Opportunity band",
      previous: previousAssessment?.band ?? null,
      current: current?.band ?? null,
    },
    {
      kind: "category",
      field: "economicsCompleteness",
      label: "Economics completeness",
      previous: previousEconomics?.completeness ?? null,
      current: currentEconomics?.completeness ?? null,
    },
    {
      kind: "category",
      field: "supplierStock",
      label: "Supplier stock",
      previous: stockLabel(previousStock?.availableInventory ?? null),
      current: stockLabel(currentStock?.availableInventory ?? null),
    },
  ];

  const rows = comparables.map(toRow);

  const noPrevious =
    previousMarket === null &&
    previousEconomics === null &&
    previousAssessment === null &&
    previousMatch === null;

  if (noPrevious) {
    return {
      status: "partial",
      rows,
      noPrevious: true,
      note: "This is the first observation Inkora has stored for this scope, so there is nothing to compare against — the figures above are first observations, not changes.",
    };
  }

  const comparable = rows.filter((row) => row.direction !== "unknown");
  return {
    status: comparable.length === 0 ? "unavailable" : "available",
    rows,
    noPrevious: false,
    note: "Comparison is against the immediately previous observation only. A single comparison is not a trend.",
  };
}

/**
 * Renders a persisted stock quantity as an honest label.
 *
 * `null` is *unknown*, never zero: an unconfirmed inventory is reported as
 * such, and is deliberately comparable (so "available → unknown" reads as a
 * change, while "unknown → unknown" does not).
 */
function stockLabel(quantity: number | null): string | null {
  if (quantity === null) {
    return "unknown";
  }
  return quantity > 0 ? "available" : "unavailable";
}
