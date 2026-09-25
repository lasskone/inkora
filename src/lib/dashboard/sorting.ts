/**
 * Deterministic sorting and filtering of Dashboard opportunities
 * (docs/ARCHITECTURE.md §19.4, §19.6).
 *
 * Pure by design — no `server-only`, no I/O — so every rule is pinned by a unit
 * test. Three rules govern it, all inherited from the layers that already make
 * these decisions:
 *
 *   1. **No new score.** Opportunities are ordered by *transparent existing
 *      fields* only — the Opportunity Engine's `score`, its separately computed
 *      evidence `confidence`, the economics layer's completeness, the matcher's
 *      confidence, or the assessment timestamp. The Dashboard invents no priority,
 *      no blend and no weighting of its own. The ladder is the scanner's
 *      (`src/lib/scanner/ranking.ts`) with a scope-stable final tie-break.
 *   2. **Missing values have explicit semantics.** An opportunity with no profit
 *      figure never counts as zero: it sinks below every opportunity that has
 *      one, and it matches neither the `profitable` nor the `losing` filter.
 *   3. **The order is reproducible.** Every key ends in a stable tie-break over
 *      provider ids, so two identical field values never produce an arbitrary
 *      order between two requests with the same data.
 */

import { parseDecimalToCents } from "@/lib/economics/money";
import type { EconomicsCompleteness } from "@/lib/opportunity/types";
import type {
  DashboardFilters,
  DashboardSortKey,
  ScopeAssessment,
} from "./types";

/** Ordinal for economics completeness, higher = more actionable. */
const COMPLETENESS_RANK: Record<EconomicsCompleteness, number> = {
  COMPLETE: 2,
  PARTIAL: 1,
  UNAVAILABLE: 0,
};

/** The keys a client may request; anything else is rejected by the route. */
export const DASHBOARD_SORT_KEYS: readonly DashboardSortKey[] = [
  "score",
  "confidence",
  "profit",
  "margin",
  "match",
  "recently-evaluated",
] as const;

/**
 * The stable final tie-break over provider ids. A NULL supplier sorts first
 * within a listing so a marketplace-only scope has a fixed, documented position
 * rather than an arbitrary one.
 */
export function scopeTieBreak(a: ScopeAssessment, b: ScopeAssessment): number {
  if (a.marketplaceExternalId !== b.marketplaceExternalId) {
    return a.marketplaceExternalId < b.marketplaceExternalId ? -1 : 1;
  }
  if (a.supplierExternalId === b.supplierExternalId) {
    return 0;
  }
  if (a.supplierExternalId === null) {
    return -1;
  }
  if (b.supplierExternalId === null) {
    return 1;
  }
  return a.supplierExternalId < b.supplierExternalId ? -1 : 1;
}

/**
 * The comparison function backing `rankOpportunities`, exported so the tie-break
 * ladder can be pinned one rule at a time. Returns a negative number when `a`
 * ranks before `b`.
 *
 * The ladder, in order — the engine's verdict first, then the evidence it rests
 * on, then how actionable its money figures are, then the product match, then the
 * stable ids:
 *
 *   1. `score` DESC                — the Opportunity Engine's verdict, unmodified.
 *   2. evidence `confidence` DESC  — for equal scores, the assessment on stronger
 *                                     evidence comes first. Confidence is a
 *                                     separate number from score and stays visibly
 *                                     prominent here, never folded into a blend.
 *   3. economics completeness DESC — COMPLETE before PARTIAL before UNAVAILABLE.
 *   4. match confidence DESC       — stronger product match first.
 *   5. provider ids ASC            — the final, stable tie-break.
 */
export function compareOpportunities(a: ScopeAssessment, b: ScopeAssessment): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.confidence !== b.confidence) {
    return b.confidence - a.confidence;
  }
  const completeness =
    COMPLETENESS_RANK[b.economicsCompleteness] - COMPLETENESS_RANK[a.economicsCompleteness];
  if (completeness !== 0) {
    return completeness;
  }
  if (a.matchConfidence !== b.matchConfidence) {
    return b.matchConfidence - a.matchConfidence;
  }
  return scopeTieBreak(a, b);
}

/** Profit in integer minor units, or `null` when no assessment recorded one. */
export function profitCents(scope: ScopeAssessment): number | null {
  return parseDecimalToCents(scope.estimatedProfit ?? null);
}

/**
 * Descending comparison where `null` always sorts last — a missing value is never
 * treated as zero and never interleaved above a present one.
 */
function compareNumbersDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return b - a;
}

/** Descending string comparison (ISO timestamps), `null` last. */
function compareStringsDesc(a: string | null, b: string | null): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  if (a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}

/**
 * Sorts opportunities by the requested key. Every key ends in the stable
 * provider-id tie-break, so the order is reproducible.
 */
export function rankOpportunities(
  scopes: readonly ScopeAssessment[],
  key: DashboardSortKey,
): ScopeAssessment[] {
  const ranked = [...scopes];
  ranked.sort((a, b) => {
    const comparison = compareByKey(a, b, key);
    return comparison !== 0 ? comparison : scopeTieBreak(a, b);
  });
  return ranked;
}

function compareByKey(
  a: ScopeAssessment,
  b: ScopeAssessment,
  key: DashboardSortKey,
): number {
  switch (key) {
    case "score":
      return compareOpportunities(a, b);

    case "confidence": {
      const byConfidence = compareNumbersDesc(a.confidence, b.confidence);
      return byConfidence !== 0 ? byConfidence : compareNumbersDesc(a.score, b.score);
    }

    case "profit": {
      const byProfit = compareNumbersDesc(profitCents(a), profitCents(b));
      return byProfit !== 0 ? byProfit : compareNumbersDesc(a.score, b.score);
    }

    case "margin": {
      const byMargin = compareNumbersDesc(a.marginPercent, b.marginPercent);
      return byMargin !== 0 ? byMargin : compareNumbersDesc(profitCents(a), profitCents(b));
    }

    case "match": {
      const byMatch = compareNumbersDesc(a.matchConfidence, b.matchConfidence);
      return byMatch !== 0 ? byMatch : compareNumbersDesc(a.score, b.score);
    }

    case "recently-evaluated":
      return compareStringsDesc(a.calculatedAt, b.calculatedAt);
  }
}

/**
 * Filters opportunities by real existing fields only (docs/ARCHITECTURE.md §19.6).
 *
 * Missing-value semantics are explicit and identical to the watchlist's
 * (§16.9): a scope with no profit figure matches neither `profitable` nor
 * `losing`, because `null` is never read as zero.
 *
 * `watched` is evaluated against the set of actively-watched scope keys the
 * service already resolved — never against a watchlist table, so this module stays
 * pure and offline-testable.
 */
export function filterOpportunities(
  scopes: readonly ScopeAssessment[],
  filters: DashboardFilters,
  watchedScopes: ReadonlySet<string>,
): ScopeAssessment[] {
  return scopes.filter((scope) => {
    if (filters.band !== undefined && scope.band !== filters.band) {
      return false;
    }
    if (filters.evidence !== undefined && scope.confidenceLevel !== filters.evidence) {
      return false;
    }
    if (filters.match !== undefined && scope.matchConfidenceBand !== filters.match) {
      return false;
    }
    if (filters.economics !== undefined && scope.economicsCompleteness !== filters.economics) {
      return false;
    }

    if (filters.profitability !== undefined) {
      const cents = profitCents(scope);
      if (cents === null) {
        return false;
      }
      if (filters.profitability === "profitable" && cents <= 0) {
        return false;
      }
      if (filters.profitability === "losing" && cents >= 0) {
        return false;
      }
    }

    if (filters.supplierScope !== undefined) {
      const isPair = scope.supplierExternalId !== null;
      if (filters.supplierScope === "pair" && !isPair) {
        return false;
      }
      if (filters.supplierScope === "marketplace-only" && isPair) {
        return false;
      }
    }

    if (filters.watchState !== undefined) {
      const watched = watchedScopes.has(scopeKey(scope));
      if (filters.watchState === "watched" && !watched) {
        return false;
      }
      if (filters.watchState === "unwatched" && watched) {
        return false;
      }
    }

    return true;
  });
}

/** The scope key a watchlist entry and an assessment agree on. */
export function scopeKey(scope: {
  marketplaceExternalId: string;
  supplierExternalId: string | null;
}): string {
  return `${scope.marketplaceExternalId}\u{0}|${scope.supplierExternalId ?? "\u{0}"}`;
}
