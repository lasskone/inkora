/**
 * Product Matcher V1 — the orchestration layer.
 *
 * This is the domain service that wires the pure pieces together for one
 * marketplace product:
 *
 * ```text
 * MarketplaceProduct
 *   → generateCandidateQueries()      (bounded, deduplicated)
 *   → SupplierAdapter.search()        (real supplier, never mocked)
 *   → dedup by supplier + externalId  (bounded pool)
 *   → scoreCandidate()                (deterministic, explainable)
 *   → ranked MatchCandidate[]
 * ```
 *
 * Provider independence: the matcher knows nothing about eBay or CJ. It speaks
 * `MarketplaceProduct` and `SupplierAdapter`, so the same code ranks candidates
 * from any future supplier adapter without changes. It never imports a provider
 * module, which also keeps it unit-testable without credentials.
 *
 * Rate-limit discipline is structural: the query count, the per-query page size
 * and the candidate pool are all hard-capped by `limits` (see
 * docs/API_INTEGRATIONS.md §4).
 */

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type {
  SupplierAdapter,
  SupplierProduct,
  SupplierSearchRequest,
} from "@/lib/supplier/types";
import { generateCandidateQueries } from "./query";
import { scoreCandidate } from "./scoring";
import type {
  MatchCandidate,
  MatchQueryOutcome,
  MatchResult,
  MatcherLimits,
} from "./types";

/**
 * Bounds applied when the caller does not supply its own. Each is chosen to
 * protect CJ's per-call quota while leaving enough candidates to rank.
 */
export const DEFAULT_MATCHER_LIMITS: MatcherLimits = {
  /** Bounded query set from the generation strategy (see ./query.ts). */
  maxQueries: 3,
  /** One page per query; CJ's `listV2` page size ceiling is 100. */
  perQueryLimit: 24,
  /** Distinct candidates collected and scored per marketplace product. */
  maxCandidates: 60,
  /** Candidates returned to the caller, after ranking. */
  maxResults: 10,
  /** Candidates enriched with a live inventory lookup (see ./inventory.ts). */
  maxInventoryLookups: 3,
};

/**
 * Matches normalized marketplace products against one supplier adapter.
 *
 * Stateless aside from the injected adapter: safe to construct per request.
 */
export class ProductMatcher {
  private readonly supplierAdapter: SupplierAdapter;
  private readonly limits: MatcherLimits;

  constructor(
    supplierAdapter: SupplierAdapter,
    limits?: Partial<MatcherLimits>,
  ) {
    this.supplierAdapter = supplierAdapter;
    this.limits = { ...DEFAULT_MATCHER_LIMITS, ...limits };
  }


  /**
   * Discovers and ranks supplier candidates for one marketplace product.
   *
   * A failing query is recorded and the remaining queries still run — one bad
   * supplier page must not kill the whole match — but every query failing
   * yields zero candidates, and the caller sees the failures.
   */
  async findCandidates(
    marketplaceProduct: MarketplaceProduct,
  ): Promise<MatchResult> {
    const queries = generateCandidateQueries(marketplaceProduct).slice(
      0,
      this.limits.maxQueries,
    );

    const outcomes: MatchQueryOutcome[] = [];
    const pool = new Map<
      string,
      SupplierProduct & { foundByQueries: string[] }
    >();

    for (const candidate of queries) {
      try {
        const request: SupplierSearchRequest = {
          query: candidate.query,
          limit: this.limits.perQueryLimit,
        };
        const result = await this.supplierAdapter.search(request);

        outcomes.push({
          query: candidate.query,
          rationale: candidate.rationale,
          count: result.count,
          failure: null,
        });

        for (const product of result.products) {
          if (pool.size >= this.limits.maxCandidates) break;
          const key = candidateKey(product);
          const existing = pool.get(key);
          if (existing) {
            if (!existing.foundByQueries.includes(candidate.query)) {
              existing.foundByQueries.push(candidate.query);
            }
            continue;
          }
          pool.set(key, { ...product, foundByQueries: [candidate.query] });
        }
      } catch (error) {
        // Never propagate raw provider errors here: the route layer owns the
        // safe HTTP translation. Record a secret-free reason and move on.
        outcomes.push({
          query: candidate.query,
          rationale: candidate.rationale,
          count: 0,
          failure:
            error instanceof Error ? error.message : "supplier query failed",
        });
      }
    }

    const candidates = [...pool.values()]
      .map((product) => this.toCandidate(marketplaceProduct, product))
      .sort(compareCandidates)
      .slice(0, this.limits.maxResults);

    return {
      marketplaceProduct,
      supplier: this.supplierAdapter.supplier,
      queries: outcomes,
      candidates,
      limits: this.limits,
    };
  }

  private toCandidate(
    marketplaceProduct: MarketplaceProduct,
    product: SupplierProduct & { foundByQueries: string[] },
  ): MatchCandidate {
    const score = scoreCandidate(marketplaceProduct, product);
    return {
      marketplaceProduct,
      supplierProduct: product,
      confidence: score.confidence,
      confidenceBand: score.confidenceBand,
      signals: score.signals,
      contradictions: score.contradictions,
      explanation: score.explanation,
      foundByQueries: product.foundByQueries,
      usWarehouseInventory: null,
      confidenceProvenance: "ESTIMATED",
    };
  }
}

/**
 * Stable ranking: confidence first, then the supplier's own id as a
 * deterministic tiebreak — the same inputs always yield the same order.
 */
function compareCandidates(left: MatchCandidate, right: MatchCandidate): number {
  if (right.confidence !== left.confidence) {
    return right.confidence - left.confidence;
  }
  return left.supplierProduct.externalId.localeCompare(
    right.supplierProduct.externalId,
  );
}

/** Deduplicates a candidate across queries by supplier + external id. */
function candidateKey(product: SupplierProduct): string {
  return `${product.supplier}:${product.externalId}`;
}
