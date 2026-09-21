/**
 * Provider-independent product-match model.
 *
 * Product Matcher V1 compares a normalized `MarketplaceProduct` against
 * normalized `SupplierProduct` candidates (see docs/ARCHITECTURE.md §8). It
 * never sees raw eBay or raw CJ payloads — only the provider-independent
 * normalized models — so the matching logic stays identical no matter which
 * marketplace or supplier adapter produced the data.
 *
 * Like the marketplace and supplier models, this module is pure type
 * declarations on purpose: it carries no runtime imports (in particular no
 * `server-only` side effects) so the deterministic scoring logic can be unit
 * tested with Node's built-in test runner without any network access.
 */

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type {
  SupplierProduct,
  UsWarehouseInventoryStatus,
} from "@/lib/supplier/types";

/**
 * Confidence bands on the 0–100 scale.
 *
 * V1 deliberately offers no "EXACT"/"GUARANTEED" band: even a high-confidence
 * text agreement remains a *candidate* until stronger verification (image or
 * identifier cross-check) exists. See docs/ARCHITECTURE.md §8.
 */
export type ConfidenceBand = "LOW" | "MEDIUM" | "HIGH";

/**
 * A positive matching signal: one deterministic, explainable reason the two
 * products might be the same item.
 */
export interface MatchSignal {
  /** Stable machine name, e.g. `distinctiveTokenAgreement`. */
  name: string;
  /** Human-readable label, e.g. `Distinctive token agreement`. */
  label: string;
  /** Points this signal contributed to the confidence (never negative here). */
  contribution: number;
  /** What was actually compared, in human-readable form. */
  detail: string;
}

/**
 * A negative signal: deterministic evidence the two products are *not* the same
 * item, or an identity attribute that conflicts.
 */
export interface MatchContradiction {
  name: string;
  label: string;
  /**
   * `hard` contradictions impose a ceiling the confidence can never exceed;
   * `soft` contradictions only subtract points. Model-number disagreement is
   * always hard (see docs/ARCHITECTURE.md §8 rules).
   */
  severity: "hard" | "soft";
  /** Confidence ceiling enforced when `severity === "hard"`. */
  cap: number;
  detail: string;
}

/**
 * One supplier candidate for a marketplace product, with the full reasoning
 * behind its confidence.
 */
export interface MatchCandidate {
  marketplaceProduct: MarketplaceProduct;
  supplierProduct: SupplierProduct;
  /** Deterministic confidence on the 0–100 scale. */
  confidence: number;
  confidenceBand: ConfidenceBand;
  /** Positive signals, ordered by descending contribution. */
  signals: MatchSignal[];
  /** Negative signals, ordered so the most damaging comes first. */
  contradictions: MatchContradiction[];
  /** Deterministic, human-readable summary of the verdict. */
  explanation: string;
  /** Deduplicated supplier queries that surfaced this candidate. */
  foundByQueries: string[];
  /**
   * US-warehouse inventory verdict. `null` until (and unless) the route
   * enriches this candidate with a bounded inventory lookup; an `UNKNOWN` here
   * is never converted into zero stock (see docs/API_INTEGRATIONS.md §3.3).
   */
  usWarehouseInventory: UsWarehouseInventoryStatus | null;
  /**
   * The confidence itself is *derived by Inkora*. It is never an eBay or CJ
   * fact, so it is always `ESTIMATED` even when both products are `OFFICIAL`.
   */
  confidenceProvenance: "ESTIMATED";
}

/**
 * The queries the matcher generated for one marketplace product, and how each
 * one fared against the supplier.
 */
export interface MatchQueryOutcome {
  query: string;
  /** Why this query was generated (deterministic strategy label). */
  rationale: string;
  /** Candidates the supplier returned for this query. */
  count: number;
  /** Failure description when the supplier rejected this query, else null. */
  failure: string | null;
}

/**
 * The full result of matching one marketplace product against one supplier.
 */
export interface MatchResult {
  marketplaceProduct: MarketplaceProduct;
  supplier: SupplierProduct["supplier"];
  queries: MatchQueryOutcome[];
  /** Ranked candidates, best confidence first. Already bounded by `limits`. */
  candidates: MatchCandidate[];
  limits: MatcherLimits;
}

/**
 * Hard bounds protecting supplier rate limits. Every matcher run stays inside
 * these numbers; see docs/API_INTEGRATIONS.md §4.
 */
export interface MatcherLimits {
  /** Maximum supplier search queries generated per marketplace product. */
  maxQueries: number;
  /** Page size requested per supplier query. */
  perQueryLimit: number;
  /** Maximum distinct candidates collected (and scored) per product. */
  maxCandidates: number;
  /** Maximum candidates returned to the caller, after ranking. */
  maxResults: number;
  /** Maximum candidates enriched with a live inventory lookup. */
  maxInventoryLookups: number;
}
