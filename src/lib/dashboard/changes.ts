/**
 * Deterministic change derivation for the Dashboard (docs/ARCHITECTURE.md
 * §19.5 — the same rules the watchlist comparison and Product Detail apply,
 * docs/ARCHITECTURE.md §16.8, §18.4).
 *
 * This is a *previous vs current* comparison over two persisted assessments —
 * never a trend, never growth, never momentum. Two points cannot establish a
 * direction of travel, and this module never implies they can.
 *
 * Standing rules, all pinned by tests:
 *
 *   - A field present on only one side is `direction: "unknown"` with a `null`
 *     delta. Missing data is never interpreted as "unchanged", and never as zero.
 *   - Money is normalized to integer minor units before subtraction and formatted
 *     back, so no binary float ever participates in arithmetic (docs/DATABASE.md §8).
 *   - A negative profit stays negative and a negative delta is reported `down`;
 *     nothing is clamped or hidden.
 *   - Categorical fields render `previous → current` with an explicit `changed` flag.
 *   - Only assessment-derived fields are compared here. Marketplace price, supplier
 *     cost and stock changes are computed against full snapshot series, which is
 *     Product Detail's job (§18) — the Dashboard compares what an *assessment*
 *     recorded, which is why profit and margin appear rather than their inputs.
 */

import { formatCents, parseDecimalToCents } from "@/lib/economics/money";
import type {
  DashboardChangeRow,
  ScopeAssessment,
  ScopeChange,
} from "./types";

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
function numericDirection(
  previous: string | null,
  current: string | null,
  delta: string | null,
): DashboardChangeRow["direction"] {
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

/** Direction of a categorical comparison; `unknown` only when both sides are absent. */
function categoricalDirection(
  previous: string | null,
  current: string | null,
): DashboardChangeRow["direction"] {
  if (previous === null && current === null) {
    return "unknown";
  }
  return previous === current ? "unchanged" : "up";
}

/** One money field the summary knows how to compare. */
interface ComparableMoney {
  kind: "money";
  field: string;
  label: string;
  previous: string | null;
  current: string | null;
}

/** One categorical field the summary knows how to compare. */
interface ComparableCategory {
  kind: "category";
  field: string;
  label: string;
  previous: string | null;
  current: string | null;
}

type Comparable = ComparableMoney | ComparableCategory;

/** Renders one comparable field into a change row. */
function toRow(comparable: Comparable): DashboardChangeRow {
  if (comparable.kind === "category") {
    return {
      field: comparable.field,
      label: comparable.label,
      previous: comparable.previous,
      current: comparable.current,
      delta: null,
      direction: categoricalDirection(comparable.previous, comparable.current),
    };
  }

  const delta = moneyDelta(comparable.previous, comparable.current);
  return {
    field: comparable.field,
    label: comparable.label,
    previous: comparable.previous,
    current: comparable.current,
    delta,
    direction: numericDirection(comparable.previous, comparable.current, delta),
  };
}

/** The fields the Dashboard compares, in the fixed order the feed renders. */
function comparablesFor(
  previous: ScopeAssessment | null,
  current: ScopeAssessment,
): Comparable[] {
  return [
    {
      kind: "money",
      field: "opportunityScore",
      label: "Opportunity score",
      previous: previous === null ? null : String(previous.score),
      current: String(current.score),
    },
    {
      kind: "money",
      field: "evidenceConfidence",
      label: "Evidence confidence",
      previous: previous === null ? null : String(previous.confidence),
      current: String(current.confidence),
    },
    {
      kind: "money",
      field: "matchConfidence",
      label: "Match confidence",
      previous: previous === null ? null : String(previous.matchConfidence),
      current: String(current.matchConfidence),
    },
    {
      kind: "money",
      field: "estimatedProfit",
      label: "Estimated profit",
      previous: previous?.estimatedProfit ?? null,
      current: current.estimatedProfit,
    },
    {
      kind: "money",
      field: "marginPercent",
      label: "Margin",
      previous: previous?.marginPercent === null || previous?.marginPercent === undefined
        ? null
        : String(previous.marginPercent),
      current: current.marginPercent === null ? null : String(current.marginPercent),
    },
    {
      kind: "category",
      field: "scoreBand",
      label: "Opportunity band",
      previous: previous?.band ?? null,
      current: current.band,
    },
    {
      kind: "category",
      field: "evidenceConfidenceLevel",
      label: "Evidence confidence level",
      previous: previous?.confidenceLevel ?? null,
      current: current.confidenceLevel,
    },
    {
      kind: "category",
      field: "economicsCompleteness",
      label: "Economics completeness",
      previous: previous?.economicsCompleteness ?? null,
      current: current.economicsCompleteness,
    },
  ];
}

/**
 * Builds the change rows for one scope — previous vs current, two observations
 * only. Rows whose both sides are missing are dropped; a row with one side
 * missing is kept and reported `unknown`, because missing data is a fact worth
 * showing rather than a reason to stay silent.
 */
export function buildChangeRows(
  previous: ScopeAssessment | null,
  current: ScopeAssessment,
): DashboardChangeRow[] {
  return comparablesFor(previous, current).map(toRow);
}

/**
 * Assembles one scope's change entry. Returns `null` when there is no previous
 * assessment — a first observation is not a change, and the caller reports it as
 * such rather than fabricating a delta.
 */
export function buildScopeChange(params: {
  previous: ScopeAssessment | null;
  current: ScopeAssessment;
}): ScopeChange | null {
  if (params.previous === null) {
    return null;
  }
  return {
    scope: params.current,
    market: null,
    rows: buildChangeRows(params.previous, params.current),
    calculatedAt: params.current.calculatedAt,
    detailHref: null,
  };
}
