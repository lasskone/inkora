/**
 * Ranking tie-break tests (docs/ARCHITECTURE.md §15.5).
 *
 * The ranking introduces no metric of its own: it orders by the Opportunity
 * Engine's score, and every tie is broken by a documented, deterministic rule.
 * These tests pin that ladder one rule at a time, so a future change cannot
 * silently make two identical inputs order differently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { MatchCandidate } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { ScanItem } from "./types";
import { compareScanItems, rankResults } from "./ranking";

const NOW = "2026-09-22T00:00:00.000Z";

function listing(id: string): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: id,
    title: "listing",
    imageUrl: null,
    listingUrl: null,
    price: "79.99",
    currency: "USD",
    condition: "NEW",
    sellerName: "seller",
    sellerFeedbackPercentage: null,
    shippingCost: "0.00",
    shippingCurrency: "USD",
    location: null,
    provenance: "OFFICIAL",
    fetchedAt: NOW,
  };
}

function item(args: {
  id: string;
  score?: number;
  confidence?: number;
  completeness?: EconomicsResult["completeness"];
  matchConfidence?: number;
}): ScanItem {
  const candidate: MatchCandidate | null =
    args.matchConfidence === undefined
      ? null
      : ({
          marketplaceProduct: listing(args.id),
          supplierProduct: {
            supplier: "cj",
            externalId: "cj-1",
            sku: null,
            title: "supplier",
            imageUrl: null,
            productUrl: null,
            category: null,
            supplierPrice: "10.00",
            currency: "USD",
            availableInventory: null,
            warehouseCountry: null,
            shippingOrigin: null,
            variants: [],
            provenance: "OFFICIAL",
            fetchedAt: NOW,
          },
          confidence: args.matchConfidence,
          confidenceBand: "MEDIUM",
          signals: [],
          contradictions: [],
          explanation: "",
          foundByQueries: [],
          usWarehouseInventory: null,
          confidenceProvenance: "ESTIMATED",
        } satisfies MatchCandidate);

  const economics: EconomicsResult | null =
    args.completeness === undefined
      ? null
      : ({
          marketplace: "ebay",
          marketplaceItemId: args.id,
          itemPrice: "79.99",
          buyerShipping: "0.00",
          grossMarketplaceRevenue: "79.99",
          currency: "USD",
          supplier: "cj",
          supplierProductId: "cj-1",
          selectedVariant: null,
          supplierProductCost: "10.00",
          supplierCostBasis: "CATALOG_MINIMUM",
          supplierShippingCost: "5.00",
          supplierShippingMethod: null,
          supplierShippingTransitTime: null,
          shippingQuotes: [],
          shippingDestination: { countryCode: "US", postalCode: null, label: "US" },
          landedSupplierCost: "15.00",
          marketplaceFee: "10.00",
          feeBreakdown: [],
          feeEngineVersion: "v",
          feeStatus: "ESTIMATED",
          feeRuleSource: "policy",
          estimatedProfit: "50.00",
          marginPercent: "62.50",
          completeness: args.completeness,
          economicsEngineVersion: "v",
          provenance: {
            itemPrice: "OFFICIAL",
            buyerShipping: "OFFICIAL",
            supplierProductCost: "OFFICIAL",
            supplierShippingCost: "OFFICIAL",
            marketplaceFee: "ESTIMATED",
            estimatedProfit: "ESTIMATED",
            marginPercent: "ESTIMATED",
          },
          assumptions: [],
          warnings: [],
          calculatedAt: NOW,
        } satisfies EconomicsResult);

  return {
    discoveryIndex: 0,
    marketplaceProduct: listing(args.id),
    matchResult: null,
    candidate,
    economics,
    assessment:
      args.score === undefined
        ? null
        : {
            engineVersion: "opportunity-v1",
            calculatedAt: NOW,
            marketplace: "ebay",
            marketplaceExternalId: args.id,
            supplier: "cj",
            supplierExternalId: "cj-1",
            score: args.score,
            band: "MEDIUM",
            confidence: args.confidence ?? 50,
            confidenceLevel: "MEDIUM",
            components: {
              economics: { score: 50 } as never,
              match: { score: 50 } as never,
              competition: { score: 50 } as never,
              demand: { score: 50 } as never,
              dataQuality: { score: 50 } as never,
            },
            factors: [],
            caps: [],
            headline: "",
            explanation: [],
            caveats: [],
            inputs: {
              marketplaceSnapshotObservedAt: null,
              supplierSnapshotObservedAt: null,
              economicsCalculatedAt: null,
              competitionQuery: null,
              historyAvailable: false,
            },
          },
    history: null,
    outcome: args.score === undefined ? "upstream-error" : "evaluated",
    durationMs: 0,
  };
}

test("higher Opportunity Engine score ranks first", () => {
  const low = item({ id: "v1|1", score: 40 });
  const high = item({ id: "v1|2", score: 80 });

  assert.ok(compareScanItems(low, high) > 0, "the weaker listing sorts after");
  assert.ok(compareScanItems(high, low) < 0, "the stronger listing sorts before");
  assert.deepEqual(
    rankResults([low, high]).map((i) => i.marketplaceProduct?.externalId),
    ["v1|2", "v1|1"],
  );
});

test("equal scores break on evidence confidence, not on id order", () => {
  const weaker = item({ id: "v1|a", score: 60, confidence: 40 });
  const stronger = item({ id: "v1|b", score: 60, confidence: 90 });

  assert.deepEqual(
    rankResults([weaker, stronger]).map((i) => i.marketplaceProduct?.externalId),
    ["v1|b", "v1|a"],
  );
});

test("equal score and confidence break on economics completeness", () => {
  const complete = item({ id: "v1|a", score: 60, confidence: 50, completeness: "COMPLETE" });
  const partial = item({ id: "v1|b", score: 60, confidence: 50, completeness: "PARTIAL" });
  const unavailable = item({ id: "v1|c", score: 60, confidence: 50, completeness: "UNAVAILABLE" });

  assert.deepEqual(
    rankResults([unavailable, partial, complete]).map((i) => i.marketplaceProduct?.externalId),
    ["v1|a", "v1|b", "v1|c"],
  );
});

test("equal score, confidence and completeness break on match confidence", () => {
  const strongMatch = item({
    id: "v1|a",
    score: 60,
    confidence: 50,
    completeness: "COMPLETE",
    matchConfidence: 80,
  });
  const weakMatch = item({
    id: "v1|b",
    score: 60,
    confidence: 50,
    completeness: "COMPLETE",
    matchConfidence: 30,
  });

  assert.deepEqual(
    rankResults([weakMatch, strongMatch]).map((i) => i.marketplaceProduct?.externalId),
    ["v1|a", "v1|b"],
  );
});

test("the final tie-break is a stable id comparison", () => {
  const everythingEqual = (id: string) =>
    item({ id, score: 60, confidence: 50, completeness: "COMPLETE", matchConfidence: 50 });

  const sorted = rankResults([
    everythingEqual("v1|zzz"),
    everythingEqual("v1|aaa"),
    everythingEqual("v1|mmm"),
  ]);

  assert.deepEqual(
    sorted.map((i) => i.marketplaceProduct?.externalId),
    ["v1|aaa", "v1|mmm", "v1|zzz"],
  );
});

test("identical inputs produce identical order across repeated sorts", () => {
  const items = [
    item({ id: "v1|3", score: 55, confidence: 60 }),
    item({ id: "v1|1", score: 55, confidence: 60 }),
    item({ id: "v1|2", score: 90, confidence: 20 }),
  ];

  const first = rankResults(items).map((i) => i.marketplaceProduct?.externalId);
  const second = rankResults(items).map((i) => i.marketplaceProduct?.externalId);

  assert.deepEqual(first, second);
  assert.deepEqual(first, ["v1|2", "v1|1", "v1|3"]);
});

