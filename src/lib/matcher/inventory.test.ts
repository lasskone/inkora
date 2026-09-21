import { test } from "node:test";
import assert from "node:assert/strict";

import { enrichWithInventory } from "@/lib/matcher/inventory";
import { scoreCandidate } from "@/lib/matcher/scoring";
import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { SupplierProduct, UsWarehouseInventoryStatus } from "@/lib/supplier/types";
import type { MatchCandidate } from "@/lib/matcher/types";

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
  sku: string | null,
): SupplierProduct {
  return {
    supplier: "cj",
    externalId,
    sku,
    title: "Soundcore Life Q30 Headphones",
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

function makeCandidate(sku: string | null): MatchCandidate {
  const supplier = makeSupplierProduct("cj-1", sku);
  return {
    marketplaceProduct: makeMarketplace("Soundcore Life Q30 Headphones"),
    supplierProduct: supplier,
    ...scoreCandidate(
      makeMarketplace("Soundcore Life Q30 Headphones"),
      supplier,
    ),
    foundByQueries: ["soundcore life q30 headphone"],
    usWarehouseInventory: null,
    confidenceProvenance: "ESTIMATED",
  };
}

test("only the top candidates are enriched, in rank order", async () => {
  const lookups: string[] = [];
  const candidates = [
    makeCandidate("SKU-A"),
    makeCandidate("SKU-B"),
    makeCandidate("SKU-C"),
  ];

  const enriched = await enrichWithInventory(
    candidates,
    async (sku) => {
      lookups.push(sku);
      return "CONFIRMED_AVAILABLE";
    },
    2,
  );

  assert.deepEqual(lookups, ["SKU-A", "SKU-B"]);
  assert.equal(enriched[0].usWarehouseInventory, "CONFIRMED_AVAILABLE");
  assert.equal(enriched[1].usWarehouseInventory, "CONFIRMED_AVAILABLE");
  assert.equal(enriched[2].usWarehouseInventory, null, "beyond the limit");
});

test("a candidate without a SKU is skipped, not guessed", async () => {
  const candidate = makeCandidate(null);
  const enriched = await enrichWithInventory(
    [candidate],
    async () => "CONFIRMED_NONE",
    3,
  );
  assert.equal(enriched[0].usWarehouseInventory, null);
});

test("UNKNOWN is preserved and never converted to zero stock", async () => {
  const candidate = makeCandidate("SKU-A");
  const enriched = await enrichWithInventory(
    [candidate],
    async () => "UNKNOWN",
    3,
  );
  assert.equal(enriched[0].usWarehouseInventory, "UNKNOWN");
});

test("a failing inventory lookup degrades to UNKNOWN without throwing", async () => {
  const candidate = makeCandidate("SKU-A");
  const enriched = await enrichWithInventory(
    [candidate],
    async () => {
      throw new Error("inventory endpoint down");
    },
    3,
  );
  assert.equal(enriched[0].usWarehouseInventory, "UNKNOWN");
});

test("CONFIRMED_NONE is reported distinctly from UNKNOWN", async () => {
  const statuses: UsWarehouseInventoryStatus[] = [
    "CONFIRMED_AVAILABLE",
    "CONFIRMED_NONE",
    "UNKNOWN",
  ];
  for (const status of statuses) {
    const candidate = makeCandidate("SKU-A");
    const enriched = await enrichWithInventory(
      [candidate],
      async () => status,
      3,
    );
    assert.equal(enriched[0].usWarehouseInventory, status);
  }
});
