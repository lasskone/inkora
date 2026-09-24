/**
 * Deterministic listing-change detection over stored observations.
 *
 * Change evidence comes from comparing a listing as it is observed now with the
 * most recent observation Inkora already stored for the same stable identity
 * (`docs/DATABASE.md` §6 — identity is separate from observation, so a title or
 * price change never orphans history). The comparison is field-by-field and
 * every change is reported with both values and both timestamps.
 *
 * Three rules keep this honest:
 *
 * 1. **Absence is not deletion.** A listing previously seen but missing from the
 *    current bounded, context-scoped sample is `not-in-current-sample`, never
 *    `delisted`. The scanner cannot prove the listing was re-queried outside its
 *    window, so it does not claim the listing ended.
 * 2. **`first-observed` is not `created`.** Inkora's own first-seen time is a
 *    different measurement from the marketplace's listing creation date and is
 *    labeled distinctly.
 * 3. **Noise is not change.** Fields are compared after normalization, so a
 *    whitespace or casing difference in a title does not masquerade as a
 *    revision.
 *
 * Pure on purpose: unit-testable with no database.
 */

import { parseDecimalToCents } from "@/lib/economics/money";

import type {
  ListingChange,
  ListingChangeKind,
  ListingChangeReport,
  ListingHistory,
  SellerListing,
} from "./types";

/**
 * A previously stored observation of one listing, in the provider-independent
 * model. The persistence layer maps a stored snapshot row into this shape, so
 * this module never sees a database row.
 */
export interface StoredListingObservation {
  externalId: string;
  title: string | null;
  price: string | null;
  currency: string | null;
  condition: string | null;
  shippingCost: string | null;
  /**
   * The currency the stored shipping cost was expressed in. The snapshot layer
   * keeps this alongside `buyer_shipping_cents`, so the shipping comparison can
   * use the stored currency rather than assuming one — otherwise every rescan
   * of a listing with priced shipping reports a phantom shipping change.
   */
  shippingCurrency: string | null;
  primaryCategoryId: string | null;
  sellerIdentifier: string | null;
  observedAt: string;
}

/** Inkora's stored identity + latest observation for one listing. */
export interface StoredListingRecord {
  firstSeenAt: string | null;
  latest: StoredListingObservation | null;
}

/**
 * Builds the change report for one scan: a history entry for every listing in
 * the current sample, plus one `not-in-current-sample` entry for every listing
 * previously seen for this seller that this bounded sample did not contain.
 */
export function summarizeListingChanges(args: {
  current: SellerListing[];
  stored: ReadonlyMap<string, StoredListingRecord>;
  currentObservedAt: string;
  persistenceAvailable: boolean;
}): ListingChangeReport {
  if (!args.persistenceAvailable) {
    return {
      histories: [],
      availability: "disabled",
      note: "Persistence is not configured on this server, so no listing history could be compared. The scan still shows current listings.",
    };
  }

  const histories = args.current.map((listing) =>
    historyForListing({
      listing,
      stored: args.stored.get(listing.externalId) ?? null,
      currentObservedAt: args.currentObservedAt,
    }),
  );

  const seenIds = new Set(args.current.map((listing) => listing.externalId));
  const absent: ListingHistory[] = [];
  for (const [externalId, record] of args.stored) {
    if (seenIds.has(externalId)) continue;
    absent.push(
      historyForAbsentListing({
        externalId,
        record,
        currentObservedAt: args.currentObservedAt,
      }),
    );
  }

  const all = [...histories, ...absent].sort((a, b) =>
    a.externalId.localeCompare(b.externalId),
  );
  const withHistory = histories.filter(
    (entry) => entry.status !== "first-observed",
  );

  return {
    histories: all,
    availability: withHistory.length > 0 ? "history" : "no-history",
    note: reportNote({
      total: all.length,
      withHistory: withHistory.length,
      absent: absent.length,
    }),
  };
}

/** The history entry for one listing present in the current sample. */
function historyForListing(args: {
  listing: SellerListing;
  stored: StoredListingRecord | null;
  currentObservedAt: string;
}): ListingHistory {
  const previous = args.stored?.latest ?? null;

  if (previous === null) {
    return {
      externalId: args.listing.externalId,
      title: args.listing.title,
      status: "first-observed",
      changes: [],
      firstObservedByInkoraAt: args.stored?.firstSeenAt ?? null,
      previousObservedAt: null,
      currentObservedAt: args.currentObservedAt,
      limitation:
        "First observation by Inkora of this listing; there is no stored value to compare against yet.",
    };
  }

  const changes = detectChanges(args.listing, previous, args.currentObservedAt);

  return {
    externalId: args.listing.externalId,
    title: args.listing.title,
    status: changes.length > 0 ? "changed" : "unchanged",
    changes,
    firstObservedByInkoraAt: args.stored?.firstSeenAt ?? null,
    previousObservedAt: previous.observedAt,
    currentObservedAt: args.currentObservedAt,
    limitation: null,
  };
}

/** The history entry for a previously seen listing absent from this sample. */
function historyForAbsentListing(args: {
  externalId: string;
  record: StoredListingRecord;
  currentObservedAt: string;
}): ListingHistory {
  return {
    externalId: args.externalId,
    title: args.record.latest?.title ?? "(title unavailable)",
    status: "not-in-current-sample",
    changes: [],
    firstObservedByInkoraAt: args.record.firstSeenAt,
    previousObservedAt: args.record.latest?.observedAt ?? null,
    currentObservedAt: args.currentObservedAt,
    limitation:
      "Absent from this bounded, context-scoped sample. This is not a delisting verdict: the scan cannot prove the listing was re-queried outside its window.",
  };
}

/**
 * Field-by-field comparison of a current listing against its last observation.
 * Deterministic; the emitted order is fixed by `kind`.
 */
export function detectChanges(
  current: SellerListing,
  previous: StoredListingObservation,
  currentObservedAt: string,
): ListingChange[] {
  const changes: ListingChange[] = [];

  const push = (
    kind: ListingChangeKind,
    from: string | null,
    to: string | null,
  ): void => {
    changes.push({
      externalId: current.externalId,
      kind,
      from,
      to,
      previousObservedAt: previous.observedAt,
      observedAt: currentObservedAt,
    });
  };

  if (!titlesEqual(previous.title, current.title)) {
    push("title", previous.title, current.title);
  }
  if (
    !pricesEqual(previous.price, previous.currency, current.price, current.currency)
  ) {
    push(
      "price",
      formatPrice(previous.price, previous.currency),
      formatPrice(current.price, current.currency),
    );
  }
  if (!stringsEqual(previous.condition, current.condition)) {
    push("condition", previous.condition, current.condition);
  }
  if (
    !pricesEqual(
      previous.shippingCost,
      previous.shippingCurrency,
      current.shippingCost,
      current.shippingCurrency,
    )
  ) {
    push("shipping", previous.shippingCost, current.shippingCost);
  }
  // Category is deliberately *not* compared: it is not part of the persisted
  // marketplace snapshot, so no stored value exists to compare against. See
  // `ListingChangeKind` in ./types for the documented V1 limitation.
  if (!stringsEqual(previous.sellerIdentifier, current.sellerName)) {
    push("seller", previous.sellerIdentifier, current.sellerName);
  }

  return changes;
}

/** Title equality after whitespace collapse; casing is treated as display noise. */
function titlesEqual(previous: string | null, current: string): boolean {
  return normalizeText(previous) === normalizeText(current);
}

/** Equality of two optional strings, absent being distinct from present. */
function stringsEqual(previous: string | null, current: string | null): boolean {
  if (previous === null && current === null) return true;
  if (previous === null || current === null) return false;
  return previous.trim() === current.trim();
}

/**
 * Price equality in minor units, so a formatting drift (`"16.1"` vs `"16.10"`)
 * is never reported as a price change, and an absent price stays distinct from a
 * priced one.
 */
function pricesEqual(
  previousValue: string | null,
  previousCurrency: string | null,
  currentValue: string | null,
  currentCurrency: string | null,
): boolean {
  const previousCents = parseDecimalToCents(previousValue);
  const currentCents = parseDecimalToCents(currentValue);
  if (previousCents === null || currentCents === null) {
    return previousCents === currentCents;
  }
  return previousCents === currentCents && previousCurrency === currentCurrency;
}

function formatPrice(value: string | null, currency: string | null): string | null {
  if (value === null) return null;
  return currency === null ? value : `${value} ${currency}`;
}

function normalizeText(value: string | null): string {
  if (value === null) return "";
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function reportNote(args: {
  total: number;
  withHistory: number;
  absent: number;
}): string {
  const parts = [
    `${args.total} listings compared against stored observations.`,
    `${args.withHistory} had a prior observation to compare with.`,
  ];
  if (args.absent > 0) {
    parts.push(
      `${args.absent} previously seen listings were absent from this bounded sample (reported, not concluded delisted).`,
    );
  }
  return parts.join(" ");
}
