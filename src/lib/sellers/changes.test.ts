/**
 * Unit tests for the listing-change detection over stored observations.
 *
 * The three honesty rules are exercised directly: absence is not deletion,
 * Inkora's first-seen time is not a creation date, and noise is not change.
 * See `src/lib/sellers/changes.ts`.
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { SellerListing } from "./types";
import {
  type StoredListingObservation,
  type StoredListingRecord,
  detectChanges,
  summarizeListingChanges,
} from "./changes";

function currentListing(args: {
  externalId: string;
  title?: string;
  price?: string | null;
  currency?: string | null;
  condition?: string | null;
  shippingCost?: string | null;
  shippingCurrency?: string | null;
  sellerName?: string | null;
}): SellerListing {
  return {
    marketplace: "ebay",
    externalId: args.externalId,
    title: args.title ?? "Sony WH-1000XM5 Headphones",
    imageUrl: null,
    listingUrl: null,
    price: args.price === undefined ? "10.00" : args.price,
    currency: args.currency === undefined ? "USD" : args.currency,
    condition: args.condition === undefined ? "New" : args.condition,
    conditionId: null,
    sellerName: args.sellerName === undefined ? "inkora-store" : args.sellerName,
    sellerFeedbackPercentage: null,
    sellerFeedbackScore: null,
    shippingCost: args.shippingCost ?? null,
    shippingCurrency: args.shippingCurrency ?? null,
    location: null,
    primaryCategoryId: null,
    primaryCategoryName: null,
    categories: [],
    buyingOptions: [],
    itemCreationDate: null,
    itemEndDate: null,
    epid: null,
    provenance: "OBSERVED",
    fetchedAt: "2026-02-01T00:00:00Z",
  };
}

function storedObservation(
  args: Partial<StoredListingObservation>,
): StoredListingObservation {
  return {
    externalId: args.externalId ?? "1",
    title: args.title ?? "Sony WH-1000XM5 Headphones",
    price: args.price === undefined ? "10.00" : args.price,
    currency: args.currency === undefined ? "USD" : args.currency,
    condition: args.condition === undefined ? "New" : args.condition,
    shippingCost: args.shippingCost ?? null,
    shippingCurrency: args.shippingCurrency ?? null,
    primaryCategoryId: args.primaryCategoryId ?? null,
    sellerIdentifier: args.sellerIdentifier ?? "inkora-store",
    observedAt: args.observedAt ?? "2026-01-01T00:00:00Z",
  };
}

const NOW = "2026-02-01T00:00:00Z";

describe("summarizeListingChanges", () => {
  it("reports the comparison as disabled when persistence is not configured", () => {
    const report = summarizeListingChanges({
      current: [currentListing({ externalId: "1" })],
      stored: new Map(),
      currentObservedAt: NOW,
      persistenceAvailable: false,
    });

    assert.equal(report.availability, "disabled");
    assert.deepEqual(report.histories, []);
    assert.ok(report.note.includes("not configured"));
  });

  it("marks a listing Inkora never saw before as first-observed", () => {
    const report = summarizeListingChanges({
      current: [currentListing({ externalId: "1" })],
      stored: new Map(),
      currentObservedAt: NOW,
      persistenceAvailable: true,
    });

    assert.equal(report.histories.length, 1);
    assert.equal(report.histories[0].status, "first-observed");
    assert.deepEqual(report.histories[0].changes, []);
    assert.equal(report.histories[0].previousObservedAt, null);
    assert.equal(report.histories[0].firstObservedByInkoraAt, null);
    assert.equal(report.availability, "no-history");
  });

  it("carries Inkora's own first-seen time, distinct from a creation date", () => {
    const stored = new Map<string, StoredListingRecord>([
      ["1", { firstSeenAt: "2026-01-01T00:00:00Z", latest: null }],
    ]);
    const report = summarizeListingChanges({
      current: [currentListing({ externalId: "1" })],
      stored,
      currentObservedAt: NOW,
      persistenceAvailable: true,
    });

    assert.equal(report.histories[0].firstObservedByInkoraAt, "2026-01-01T00:00:00Z");
  });

  it("reports a previously seen listing missing from the sample as absent, not delisted", () => {
    const stored = new Map<string, StoredListingRecord>([
      [
        "9",
        {
          firstSeenAt: "2026-01-01T00:00:00Z",
          latest: storedObservation({ externalId: "9" }),
        },
      ],
    ]);
    const report = summarizeListingChanges({
      current: [currentListing({ externalId: "1" })],
      stored,
      currentObservedAt: NOW,
      persistenceAvailable: true,
    });

    const absent = report.histories.find((entry) => entry.externalId === "9");
    assert.equal(absent?.status, "not-in-current-sample");
    assert.deepEqual(absent?.changes, []);
    assert.ok(absent?.limitation?.includes("not a delisting verdict"));
  });

  it("reports history availability when at least one listing had a prior observation", () => {
    const stored = new Map<string, StoredListingRecord>([
      [
        "1",
        {
          firstSeenAt: "2026-01-01T00:00:00Z",
          latest: storedObservation({ externalId: "1" }),
        },
      ],
    ]);
    const report = summarizeListingChanges({
      current: [currentListing({ externalId: "1" })],
      stored,
      currentObservedAt: NOW,
      persistenceAvailable: true,
    });

    assert.equal(report.availability, "history");
    assert.ok(report.note.includes("1 listings compared"));
  });
});

describe("detectChanges", () => {
  it("reports no change when only formatting or casing drifted", () => {
    const changes = detectChanges(
      currentListing({
        externalId: "1",
        price: "16.1",
        title: "sony  wh-1000xm5 headphones",
      }),
      storedObservation({
        externalId: "1",
        price: "16.10",
        title: "Sony WH-1000XM5 Headphones",
      }),
      NOW,
    );

    assert.deepEqual(changes, []);
  });

  it("reports a price change with both values and both timestamps", () => {
    const changes = detectChanges(
      currentListing({ externalId: "1", price: "12.50" }),
      storedObservation({ externalId: "1", price: "10.00" }),
      NOW,
    );

    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "price");
    assert.equal(changes[0].from, "10.00 USD");
    assert.equal(changes[0].to, "12.50 USD");
    assert.equal(changes[0].previousObservedAt, "2026-01-01T00:00:00Z");
    assert.equal(changes[0].observedAt, NOW);
  });

  it("reports a gained price, keeping absent distinct from free", () => {
    const changes = detectChanges(
      currentListing({ externalId: "1", price: "12.50" }),
      storedObservation({ externalId: "1", price: null }),
      NOW,
    );

    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "price");
    assert.equal(changes[0].from, null);
  });

  it("reports a title, condition, shipping and seller change in a fixed order", () => {
    const changes = detectChanges(
      currentListing({
        externalId: "1",
        title: "Sony WH-1000XM5 Headphones (2026)",
        price: "12.50",
        condition: "Used",
        shippingCost: "5.00",
        shippingCurrency: "USD",
        sellerName: "renamed-store",
      }),
      storedObservation({
        externalId: "1",
        condition: "New",
        shippingCost: null,
        sellerIdentifier: "inkora-store",
      }),
      NOW,
    );

    assert.deepEqual(
      changes.map((change) => change.kind),
      ["title", "price", "condition", "shipping", "seller"],
    );
  });

  it("treats a currency change as a price change", () => {
    const changes = detectChanges(
      currentListing({ externalId: "1", price: "10.00", currency: "EUR" }),
      storedObservation({ externalId: "1", price: "10.00", currency: "USD" }),
      NOW,
    );

    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "price");
  });

  it("keeps absent shipping distinct from free shipping", () => {
    const changes = detectChanges(
      currentListing({
        externalId: "1",
        shippingCost: "0.00",
        shippingCurrency: "USD",
      }),
      storedObservation({ externalId: "1", shippingCost: null }),
      NOW,
    );

    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "shipping");
    assert.equal(changes[0].from, null);
    assert.equal(changes[0].to, "0.00");
  });

  it("reports no shipping change when stored shipping matches, including its currency", () => {
    // Regression: the stored shipping currency must be read from the stored
    // observation. Assuming it was null made every rescan of a listing with
    // priced shipping report "0.00 → 0.00" as a change.
    const changes = detectChanges(
      currentListing({
        externalId: "1",
        shippingCost: "0.00",
        shippingCurrency: "USD",
      }),
      storedObservation({
        externalId: "1",
        shippingCost: "0.00",
        shippingCurrency: "USD",
      }),
      NOW,
    );

    assert.deepEqual(changes, []);
  });

  it("reports a shipping change when only the shipping currency moved", () => {
    const changes = detectChanges(
      currentListing({
        externalId: "1",
        shippingCost: "0.00",
        shippingCurrency: "EUR",
      }),
      storedObservation({
        externalId: "1",
        shippingCost: "0.00",
        shippingCurrency: "USD",
      }),
      NOW,
    );

    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "shipping");
  });
});
