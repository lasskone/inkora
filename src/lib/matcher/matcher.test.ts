import { test } from "node:test";
import assert from "node:assert/strict";

import { ProductMatcher } from "@/lib/matcher/matcher";
import { DEFAULT_MATCHER_LIMITS } from "@/lib/matcher/matcher";
import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type {
  SupplierAdapter,
  SupplierProduct,
  SupplierSearchRequest,
  SupplierSearchResult,
} from "@/lib/supplier/types";

function makeMarketplace(title: string): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: "v1|123",
    title,
    imageUrl: null,
    listingUrl: null,
    price: "29.99",
    currency: "USD",
    condition: "NEW",
    sellerName: null,
    sellerFeedbackPercentage: null,
    shippingCost: null,
    shippingCurrency: null,
    location: null,
    provenance: "OFFICIAL",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeSupplierProduct(
  externalId: string,
  title: string,
): SupplierProduct {
  return {
    supplier: "cj",
    externalId,
    sku: `SKU-${externalId}`,
    title,
    imageUrl: null,
    productUrl: null,
    category: null,
    supplierPrice: "12.50",
    currency: "USD",
    availableInventory: null,
    warehouseCountry: null,
    shippingOrigin: null,
    variants: [],
    provenance: "OFFICIAL",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * A deterministic fake supplier adapter: returns canned pages per query and
 * records every request, so the tests can assert bounds without touching CJ.
 */
class FakeSupplierAdapter implements SupplierAdapter {
  readonly supplier = "cj" as const;
  readonly requests: SupplierSearchRequest[] = [];
  private readonly pages: Map<string, SupplierProduct[]>;

  constructor(pages: Map<string, SupplierProduct[]>) {
    this.pages = pages;
  }

  async search(
    request: SupplierSearchRequest,
  ): Promise<SupplierSearchResult> {
    this.requests.push(request);
    const products = this.pages.get(request.query) ?? [];
    return {
      query: request.query,
      limit: request.limit,
      offset: request.offset ?? 0,
      total: products.length,
      count: products.length,
      products,
    };
  }
}

test("candidates are deduplicated across queries and ranked", async () => {
  const shared = makeSupplierProduct("cj-1", "Soundcore Life Q30 Headphones");
  const pages = new Map<string, SupplierProduct[]>([
    ["soundcore life q30 headphone", [shared]],
    ["q30", [shared, makeSupplierProduct("cj-2", "Generic Earbuds")]],
  ]);
  const adapter = new FakeSupplierAdapter(pages);

  const result = await new ProductMatcher(adapter).findCandidates(
    makeMarketplace("Soundcore Life Q30 Wireless Headphones"),
  );

  const ids = result.candidates.map(
    (candidate) => candidate.supplierProduct.externalId,
  );
  assert.equal(new Set(ids).size, ids.length, "no duplicate candidates");
  assert.ok(ids.includes("cj-1"));
  assert.ok(
    ids.indexOf("cj-1") === 0,
    "the best-scoring candidate must rank first",
  );
  // The shared candidate was surfaced by two queries.
  const top = result.candidates[0];
  assert.ok(top.foundByQueries.length >= 1);
  assert.equal(top.usWarehouseInventory, null, "not enriched yet");
  assert.equal(top.confidenceProvenance, "ESTIMATED");
});

test("every query respects the configured bounds", async () => {
  const pages = new Map<string, SupplierProduct[]>([
    ["soundcore life q30 headphone", [makeSupplierProduct("cj-1", "Soundcore Life Q30 Headphones")]],
  ]);
  const adapter = new FakeSupplierAdapter(pages);

  const result = await new ProductMatcher(adapter, { maxQueries: 2, maxResults: 1 }).findCandidates(
    makeMarketplace("Soundcore Life Q30 Wireless Headphones"),
  );

  assert.ok(adapter.requests.length <= 2, "query count must be bounded");
  for (const request of adapter.requests) {
    assert.ok(
      request.limit <= DEFAULT_MATCHER_LIMITS.perQueryLimit,
      "page size must be bounded",
    );
  }
  assert.ok(result.candidates.length <= 1, "result count must be bounded");
  assert.equal(result.limits.maxQueries, 2);
});

test("a failing query is recorded but does not abort the run", async () => {
  class FlakyAdapter extends FakeSupplierAdapter {
    constructor() {
      super(new Map());
    }
    async search(request: SupplierSearchRequest): Promise<SupplierSearchResult> {
      this.requests.push(request);
      if (request.query.includes("q30")) {
        throw new Error("upstream is unhappy");
      }
      return super.search(request);
    }
  }

  const adapter = new FlakyAdapter();
  const result = await new ProductMatcher(adapter).findCandidates(
    makeMarketplace("Soundcore Life Q30 Wireless Headphones"),
  );

  assert.ok(result.queries.some((entry) => entry.failure !== null));
  assert.ok(result.queries.length > 1, "other queries still ran");
});

test("no usable supplier results yields an empty, honest candidate list", async () => {
  const adapter = new FakeSupplierAdapter(new Map());
  const result = await new ProductMatcher(adapter).findCandidates(
    makeMarketplace("Obscure Unobtainium Gizmo 9000"),
  );
  assert.equal(result.candidates.length, 0);
  assert.ok(result.queries.length >= 1);
});

test("matching is deterministic across repeated runs", async () => {
  const pages = new Map<string, SupplierProduct[]>([
    ["soundcore life q30 headphone", [makeSupplierProduct("cj-1", "Soundcore Life Q30 Headphones")]],
    ["q30", [makeSupplierProduct("cj-2", "Life Q30 ANC Headphones")]],
  ]);
  const market = makeMarketplace("Soundcore Life Q30 Wireless Headphones");

  const first = await new ProductMatcher(new FakeSupplierAdapter(pages)).findCandidates(market);
  const second = await new ProductMatcher(new FakeSupplierAdapter(pages)).findCandidates(market);

  assert.deepEqual(
    first.candidates.map((candidate) => candidate.confidence),
    second.candidates.map((candidate) => candidate.confidence),
  );
});
