"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { formatMoney } from "@/app/products/product-scanner";
import { productDetailPageParams } from "@/lib/product-detail/product-detail-links";
import type { SectionStatus, ProductDetail } from "@/lib/product-detail/types";
import type {
  ProductDetailErrorResponse,
  ProductDetailRefreshSuccessResponse,
  ProductDetailSuccessResponse,
} from "@/types/product-detail";
import type {
  WatchlistAddSuccessResponse,
  WatchlistArchiveSuccessResponse,
  WatchlistErrorResponse,
} from "@/types/watchlist";

/**
 * Product Detail — the opportunity intelligence for one listing
 * (docs/MVP_SPEC.md §4.4, docs/ARCHITECTURE.md §18).
 *
 * The browser carries only ids and the query that surfaced the listing. Every
 * figure rendered below is a stored observation with its own timestamp, or a
 * value the server derived from stored observations — never a client-side
 * guess. Nothing here re-scores, re-matches or re-prices anything: the read
 * performs no upstream call at all, and the refresh is a deliberate action the
 * reader takes, with a bounded budget and a stated outcome.
 */

const WATCHLIST_ENDPOINT = "/api/watchlist";

type ReadStatus =
  | "loading"
  | "ready"
  | "not-observed"
  | "not-configured"
  | "error"
  | "invalid";

type RefreshState = {
  status: "idle" | "refreshing" | "done" | "failed";
  outcome?: ProductDetailRefreshSuccessResponse["outcome"];
  message?: string;
};

type WatchState = {
  status: "idle" | "adding" | "added" | "archiving" | "archived" | "failed";
  entryId?: string | null;
  message?: string;
};

const REFRESH_OUTCOME_COPY: Record<
  ProductDetailRefreshSuccessResponse["outcome"],
  string
> = {
  evaluated: "Re-evaluated — a fresh assessment was produced and persisted.",
  "no-candidates":
    "No supplier candidate found this time. Still a full, explainable verdict — the engine hard-caps it at LOW.",
  "economics-unavailable":
    "A candidate exists but no shipping quote could be obtained, so economics are UNAVAILABLE.",
  "item-not-found": "The listing scrolled out of the replayed search window.",
  "candidate-not-resolved":
    "The persisted supplier is no longer a matcher candidate for this listing. It was never substituted; the stored pairing is untouched.",
  "upstream-error":
    "An eBay or CJ failure the refresh could not recover from. The stored observations are untouched.",
};

const STATUS_BADGE: Record<SectionStatus, string> = {
  available: "border-border text-muted",
  partial: "border-amber-500/60 text-amber-600 dark:text-amber-400",
  unavailable: "border-border text-muted",
  stale: "border-border text-muted",
};

const STATUS_LABEL: Record<SectionStatus, string> = {
  available: "available",
  partial: "partial",
  unavailable: "unavailable",
  stale: "stale",
};

/** Renders an observation timestamp as a stable, locale-independent label. */
function observedAt(iso: string | null): string {
  if (iso === null) {
    return "never observed";
  }
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/** A decimal-string money field, or the honest label when it was never stored. */
function money(value: string | null, currency: string | null): string {
  return value === null ? "not stored" : formatMoney(value, currency);
}

/** A decimal-string percentage already scaled by its engine, or its absence. */
function percent(value: string | null): string {
  return value === null ? "not stored" : `${value}%`;
}

/** A signed decimal-string delta with its direction, or `null` when unknown. */
function signedPercent(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return `${parsed > 0 ? "+" : parsed < 0 ? "−" : ""}${Math.abs(parsed)}%`;
}

function SectionStatusBadge({ status }: { status: SectionStatus }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_BADGE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function SectionShell({
  title,
  status,
  note,
  children,
}: {
  title: string;
  status: SectionStatus;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-5 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <SectionStatusBadge status={status} />
      </div>
      {note !== undefined && note.length > 0 && (
        <p className="text-xs text-muted">{note}</p>
      )}
      {children}
    </section>
  );
}

function EmptyObservation({ label }: { label: string }) {
  return (
    <p className="text-sm text-muted">
      {label} No stored observation exists for this section, so nothing is
      shown in its place — not zero, and not an estimate.
    </p>
  );
}


export function ProductDetailPanel({ itemId }: { itemId: string }) {
  const searchParams = useSearchParams();
  const scope = productDetailPageParams({ itemId, searchParams });

  const [status, setStatus] = useState<ReadStatus>("loading");
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [historyLimit, setHistoryLimit] = useState<number | null>(null);
  const [refreshAvailable, setRefreshAvailable] = useState<boolean>(false);
  const [readMessage, setReadMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<RefreshState>({ status: "idle" });
  const [watch, setWatch] = useState<WatchState>({ status: "idle" });

  const readEndpoint =
    scope === null
      ? null
      : `/api/products/${encodeURIComponent(itemId)}?q=${encodeURIComponent(scope.query)}` +
        (scope.supplierProductId === null
          ? ""
          : `&supplierProductId=${encodeURIComponent(scope.supplierProductId)}`);

  const read = useCallback(async (): Promise<void> => {
    if (readEndpoint === null) {
      setStatus("invalid");
      return;
    }

    setStatus("loading");
    setReadMessage(null);

    let response: Response;
    try {
      response = await fetch(readEndpoint, { cache: "no-store" });
    } catch {
      setStatus("error");
      setReadMessage("The request to read this listing's observations did not complete.");
      return;
    }

    const payload = (await response.json()) as
      | ProductDetailSuccessResponse
      | ProductDetailErrorResponse;

    if (!response.ok || payload.status !== "ok") {
      const error = payload as ProductDetailErrorResponse;
      if (error.code === "PERSISTENCE_NOT_CONFIGURED") {
        setStatus("not-configured");
        setReadMessage(error.error);
      } else {
        setStatus("error");
        setReadMessage(`${error.error} (${error.code})`);
      }
      return;
    }

    setHistoryLimit(payload.historyLimit);
    setRefreshAvailable(payload.refreshAvailable);

    if (payload.outcome === "not-observed" || payload.detail === undefined) {
      setDetail(null);
      setStatus("not-observed");
      return;
    }

    setDetail(payload.detail);
    setStatus("ready");
  }, [readEndpoint]);

  /**
   * Initial read of the persisted observation, plus a re-read whenever the
   * route key changes. This is a one-shot read of an external system, so the
   * reading state has to flip before the first await: the state it sets
   * replaces the rendered detail instead of deriving from it, so there is no
   * cascading render to avoid.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
  }, [read]);

  const refreshNow = useCallback(async (): Promise<void> => {
    if (readEndpoint === null || refresh.status === "refreshing") {
      return;
    }

    setRefresh({ status: "refreshing" });

    let response: Response;
    try {
      response = await fetch(readEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          scope?.destinationCountry !== null && scope?.destinationCountry !== undefined
            ? { destinationCountry: scope.destinationCountry }
            : {},
        ),
        cache: "no-store",
      });
    } catch {
      setRefresh({
        status: "failed",
        message: "The refresh request did not complete.",
      });
      return;
    }

    const payload = (await response.json()) as
      | ProductDetailRefreshSuccessResponse
      | ProductDetailErrorResponse;

    if (!response.ok || payload.status !== "ok") {
      const error = payload as ProductDetailErrorResponse;
      setRefresh({ status: "failed", message: `${error.error} (${error.code})` });
      return;
    }

    const succeeded = payload as ProductDetailRefreshSuccessResponse;
    setRefresh({
      status: "done",
      outcome: succeeded.outcome,
      message: REFRESH_OUTCOME_COPY[succeeded.outcome],
    });

    // The page always reflects storage, so the read model is re-read after a
    // refresh rather than rebuilt from the response.
    await read();
  }, [readEndpoint, refresh.status, scope, read]);

  const addToWatchlist = useCallback(async (): Promise<void> => {
    if (scope === null || watch.status === "adding") {
      return;
    }

    setWatch({ status: "adding" });

    let response: Response;
    try {
      response = await fetch(WATCHLIST_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketplaceExternalId: itemId,
          supplierExternalId: scope.supplierProductId,
          replayQuery: scope.query,
          label: null,
        }),
        cache: "no-store",
      });
    } catch {
      setWatch({ status: "failed", message: "The watchlist save did not complete." });
      return;
    }

    const payload = (await response.json()) as
      | WatchlistAddSuccessResponse
      | WatchlistErrorResponse;

    if (!response.ok || payload.status !== "ok") {
      const error = payload as WatchlistErrorResponse;
      setWatch({ status: "failed", message: `${error.error} (${error.code})` });
      return;
    }

    const added = payload as WatchlistAddSuccessResponse;
    setWatch({
      status: "added",
      entryId: added.entry.entry.id,
      message: `${added.action === "inserted" ? "Added to" : "Already on"} the watchlist as entry ${added.entry.entry.id}.`,
    });
    void read();
  }, [scope, watch.status, itemId, read]);

  const unwatch = useCallback(
    async (entryId: string): Promise<void> => {
      if (watch.status === "archiving") {
        return;
      }

      setWatch({ status: "archiving", entryId });

      let response: Response;
      try {
        response = await fetch(
          `${WATCHLIST_ENDPOINT}/${encodeURIComponent(entryId)}/archive`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
            cache: "no-store",
          },
        );
      } catch {
        setWatch({ status: "failed", message: "The archive request did not complete." });
        return;
      }

      const payload = (await response.json()) as
        | WatchlistArchiveSuccessResponse
        | WatchlistErrorResponse;

      if (!response.ok || payload.status !== "ok") {
        const error = payload as WatchlistErrorResponse;
        setWatch({ status: "failed", message: `${error.error} (${error.code})` });
        return;
      }

      setWatch({
        status: "archived",
        message: "Archived. The entry keeps its history but is no longer monitored.",
      });
      void read();
    },
    [watch.status, read],
  );


  if (scope === null || status === "invalid") {
    return <InvalidScope itemId={itemId} />;
  }

  if (status === "loading") {
    return (
      <div
        role="status"
        className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted"
      >
        Reading the persisted observations for this listing…
      </div>
    );
  }

  if (status === "not-configured") {
    return (
      <ErrorState
        title="Persistence is not configured"
        message={
          readMessage ?? "This server has no persistence, so nothing has been observed."
        }
        hint="Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local and restart."
      />
    );
  }

  if (status === "error") {
    return (
      <ErrorState
        title="This listing could not be read"
        message={readMessage ?? "The read failed for an unknown reason."}
      />
    );
  }

  if (status === "not-observed" || detail === null) {
    return (
      <NeverObserved
        itemId={itemId}
        query={scope.query}
        supplierProductId={scope.supplierProductId}
        refreshAvailable={refreshAvailable}
        refreshing={refresh.status === "refreshing"}
        refreshMessage={refresh.message ?? null}
        onRefresh={refreshNow}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Header
        detail={detail}
        itemId={itemId}
        query={scope.query}
        supplierProductId={scope.supplierProductId}
        refreshAvailable={refreshAvailable}
        refreshing={refresh.status === "refreshing"}
        refresh={refresh}
        watch={watch}
        onRefresh={refreshNow}
        onAdd={addToWatchlist}
        onUnwatch={unwatch}
      />

      {historyLimit !== null && (
        <p className="text-xs text-muted">
          History is bounded at {historyLimit} observations per series. Everything below
          is a stored fact with its own timestamp; nothing is a live claim about the
          listing&apos;s present state.
        </p>
      )}

      {detail.warnings.length > 0 && (
        <ul className="flex flex-col gap-1.5 rounded-lg border border-amber-500/40 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {detail.warnings.map((warning) => (
            <li key={warning}>⚠ {warning}</li>
          ))}
        </ul>
      )}

      <MarketSection detail={detail} />
      <SupplierSection detail={detail} />
      <MatchSection detail={detail} />
      <EconomicsSection detail={detail} />
      <OpportunitySection detail={detail} />
      <CompetitionSection detail={detail} />
      <HistorySection detail={detail} />
      <FreshnessSection detail={detail} />
    </div>
  );
}


function InvalidScope({ itemId }: { itemId: string }) {
  return (
    <ErrorState
      title="This detail link is not usable"
      message={`The link for item ${itemId} does not carry the search query that surfaced it, or it carries ids the boundary refuses. A Product Detail page needs the item id and that query — without the query a refresh has no window to replay.`}
      hint="Open this listing again from the product scanner, the seller scanner or the watchlist, where the link is built from the ids the server itself resolved."
    />
  );
}

function ErrorState({
  title,
  message,
  hint,
}: {
  title: string;
  message: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-6 sm:px-6">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted">{message}</p>
      {hint !== undefined && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

function NeverObserved({
  itemId,
  query,
  supplierProductId,
  refreshAvailable,
  refreshing,
  refreshMessage,
  onRefresh,
}: {
  itemId: string;
  query: string;
  supplierProductId: string | null;
  refreshAvailable: boolean;
  refreshing: boolean;
  refreshMessage: string | null;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-4 py-8 sm:px-6">
      <h1 className="text-lg font-semibold tracking-tight">
        Inkora has never stored an observation for this listing
      </h1>
      <p className="text-sm text-muted">
        Item <code className="font-mono text-xs">{itemId}</code> for the query “{query}”
        {supplierProductId !== null
          ? ` paired with supplier product ${supplierProductId}`
          : " with no supplier in scope"}
        . Nothing on this page is a live claim about the product — no price, no
        cost, no score and no confidence has been observed, so none is shown. Zero
        would be a claim; this is an absence.
      </p>
      {refreshMessage !== null && (
        <p className="text-sm text-foreground">{refreshMessage}</p>
      )}
      {refreshAvailable ? (
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={refreshing}
          className="self-start rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {refreshing ? "Evaluating…" : "Evaluate this listing now"}
        </button>
      ) : (
        <p className="text-xs text-muted">
          A live evaluation needs eBay and CJdropshipping to be configured on this
          server. Neither is available right now.
        </p>
      )}
    </div>
  );
}


function Header({
  detail,
  itemId,
  query,
  supplierProductId,
  refreshAvailable,
  refreshing,
  refresh,
  watch,
  onRefresh,
  onAdd,
  onUnwatch,
}: {
  detail: ProductDetail;
  itemId: string;
  query: string;
  supplierProductId: string | null;
  refreshAvailable: boolean;
  refreshing: boolean;
  refresh: RefreshState;
  watch: WatchState;
  onRefresh: () => Promise<void>;
  onAdd: () => Promise<void>;
  onUnwatch: (entryId: string) => Promise<void>;
}) {
  const snapshot = detail.market.snapshot;
  const entryId = detail.watchlist.entryId;

  return (
    <header className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs uppercase tracking-wide text-muted">
            {detail.marketplace} · item <span className="font-mono">{itemId}</span>
          </p>
          <h1 className="text-xl font-semibold tracking-tight">
            {snapshot === null ? "Untitled listing" : snapshot.title}
          </h1>
          <p className="text-sm text-muted">
            {supplierProductId === null
              ? "Marketplace-only view — no supplier is in scope."
              : `Paired scope — supplier product ${supplierProductId}.`}
            {" The figures below are observations, not the listing's present state."}
          </p>
        </div>

        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          {refreshAvailable && (
            <button
              type="button"
              onClick={() => void onRefresh()}
              disabled={refreshing}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {refreshing ? "Re-evaluating…" : "Re-evaluate now"}
            </button>
          )}
          {entryId === null ? (
            <button
              type="button"
              onClick={() => void onAdd()}
              disabled={watch.status === "adding"}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted/10 disabled:opacity-50"
            >
              {watch.status === "adding" ? "Saving…" : "Watch this opportunity"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onUnwatch(entryId)}
              disabled={watch.status === "archiving"}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted/10 disabled:opacity-50"
            >
              {watch.status === "archiving"
                ? "Archiving…"
                : detail.watchlist.archived
                  ? "Archived — not monitored"
                  : "On the watchlist · stop monitoring"}
            </button>
          )}
        </div>
      </div>

      {detail.replayQuery !== null && detail.replayQuery !== query && (
        <p className="text-xs text-muted">
          The stored replay query for this listing is “{detail.replayQuery}”. The link
          you arrived with said “{query}”; the stored one is what a refresh replays.
        </p>
      )}

      {refresh.message !== undefined && (
        <p className="text-sm text-foreground">
          {refresh.status === "failed" ? "⚠ " : ""}
          {refresh.message}
        </p>
      )}
      {watch.message !== undefined && (
        <p className="text-sm text-foreground">
          {watch.status === "failed" ? "⚠ " : ""}
          {watch.message}
        </p>
      )}
    </header>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-sm">
        {value === null || value === undefined || value === "" ? "unknown" : value}
      </dd>
    </div>
  );
}

function DefinitionList({
  children,
}: {
  children: React.ReactNode;
}) {
  return <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">{children}</dl>;
}


function MarketSection({ detail }: { detail: ProductDetail }) {
  const market = detail.market;
  const snapshot = market.snapshot;

  return (
    <SectionShell
      title="Market — what the marketplace showed"
      status={market.status}
      note="The latest stored marketplace observation. Buying options, category and listing creation date are not persisted by any boundary, so they are reported as unsupported rather than invented."
    >
      {snapshot === null ? (
        <EmptyObservation label="No marketplace snapshot is stored for this listing." />
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row">
          {snapshot.imageUrl !== null && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={snapshot.imageUrl}
              alt=""
              className="h-24 w-24 shrink-0 rounded border border-border object-cover"
            />
          )}
          <div className="flex flex-1 flex-col gap-4">
            <DefinitionList>
              <Field
                label="Price as observed"
                value={
                  snapshot.price === null
                    ? null
                    : formatMoney(snapshot.price, snapshot.currency)
                }
              />
              <Field
                label="Buyer shipping"
                value={
                  snapshot.shippingCost === null
                    ? null
                    : formatMoney(snapshot.shippingCost, snapshot.shippingCurrency)
                }
              />
              <Field label="Condition" value={snapshot.condition} />
              <Field label="Seller" value={snapshot.sellerName} />
              <Field
                label="Seller feedback"
                value={
                  snapshot.sellerFeedbackPercentage === null
                    ? null
                    : `${snapshot.sellerFeedbackPercentage}%`
                }
              />
              <Field label="Ships from" value={snapshot.location} />
            </DefinitionList>
            <div className="flex flex-wrap gap-3 text-xs text-muted">
              <span>Observed {observedAt(snapshot.observedAt)}</span>
              {snapshot.listingUrl !== null && (
                <a
                  href={snapshot.listingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  View the listing on {detail.marketplace}
                </a>
              )}
            </div>
          </div>
        </div>
      )}
      {market.unsupported.length > 0 && (
        <p className="text-xs text-muted">
          Unsupported here: {market.unsupported.join(", ")}.
        </p>
      )}
    </SectionShell>
  );
}


function SupplierSection({ detail }: { detail: ProductDetail }) {
  const supplier = detail.supplier;

  return (
    <SectionShell
      title="Supplier — the sourcing evidence"
      status={supplier.status}
      note="What CJdropshipping stored for this product. A persisted cost is labelled by what it actually is — a selected variant, a reference, or a catalogue minimum — and a cost basis other than the selected variant is partial evidence, not a landed cost."
    >
      {supplier.externalId === null ? (
        <EmptyObservation label="No supplier product is in scope for this view." />
      ) : (
        <>
          <DefinitionList>
            <Field label="Supplier product" value={supplier.externalId} />
            <Field label="Title" value={supplier.title} />
            <Field
              label="Reference cost"
              value={
                supplier.referenceCost === null
                  ? null
                  : money(supplier.referenceCost, supplier.currency)
              }
            />
            <Field label="Cost basis" value={supplier.costBasis} />
            <Field
              label="Persisted product cost"
              value={money(supplier.productCost, supplier.currency)}
            />
            <Field
              label="Persisted shipping cost"
              value={money(supplier.shippingCost, supplier.currency)}
            />
            <Field label="Selected shipping method" value={supplier.shippingMethod} />
            <Field label="Transit time" value={supplier.transitTime} />
            <Field
              label="US warehouse inventory"
              value={
                supplier.usWarehouseInventory === null
                  ? null
                  : supplier.usWarehouseInventory === "UNKNOWN"
                    ? "never confirmed"
                    : supplier.usWarehouseInventory === "CONFIRMED_AVAILABLE"
                      ? "confirmed available"
                      : "confirmed none"
              }
            />
            <Field label="Warehouse country" value={supplier.warehouseCountry} />
            <Field
              label="Available inventory"
              value={
                supplier.availableInventory === null
                  ? null
                  : supplier.availableInventory.toLocaleString()
              }
            />
            <Field label="Observed" value={observedAt(supplier.observedAt)} />
          </DefinitionList>

          {supplier.shippingQuotes.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Every shipping quote the supplier returned
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {supplier.shippingQuotes.map((quote) => (
                  <li key={quote.method} className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>{quote.method}</span>
                    <span className="text-muted">
                      {money(quote.cost, quote.currency)}
                      {quote.transitTime !== null ? ` · ${quote.transitTime}` : ""}
                      {quote.originCountry !== null ? ` · from ${quote.originCountry}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {supplier.provenance !== null && (
            <p className="text-xs text-muted">
              Cost provenance: {supplier.provenance}. A reference cost is what the
              catalogue showed then; only a selected-variant cost is what the
              economics actually used.
            </p>
          )}
        </>
      )}
    </SectionShell>
  );
}


function MatchSection({ detail }: { detail: ProductDetail }) {
  const match = detail.match;

  return (
    <SectionShell
      title="Match — how confident Inkora is these are the same product"
      status={match.status}
      note="The matcher's own stored verdict and the signals it used. A hard contradiction caps the confidence by design; the cap is reported, never hidden."
    >
      {match.confidence === null ? (
        <EmptyObservation label="No match observation is stored for this pairing." />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-3xl font-semibold tabular-nums">
              {match.confidence}
              <span className="ml-1 text-sm font-normal text-muted">/ 100</span>
            </span>
            {match.confidenceBand !== null && (
              <span className="text-sm text-muted">{match.confidenceBand} confidence</span>
            )}
            {match.cappedByHardContradiction && (
              <span className="rounded border border-amber-500/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                capped by a hard contradiction
              </span>
            )}
          </div>

          {match.explanation !== null && (
            <p className="text-sm text-foreground">{match.explanation}</p>
          )}

          {match.signals.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Signals the matcher used
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {match.signals.map((signal) => (
                  <li key={signal.label}>
                    <span className="font-medium">{signal.label}</span>
                    <span className="text-muted"> — {signal.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {match.contradictions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Contradictions found
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {match.contradictions.map((contradiction) => (
                  <li key={contradiction.label}>
                    <span className="font-medium">{contradiction.label}</span>
                    <span className="text-muted"> — {contradiction.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {match.economicsReferToPossibleDifferentProduct && (
            <p className="rounded border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              The match is LOW confidence and economics exist for this pairing. The
              money below may describe a different physical product — read it as a
              cost hypothesis, not a landed cost.
            </p>
          )}

          {match.caveats.map((caveat) => (
            <p key={caveat} className="text-xs text-muted">
              {caveat}
            </p>
          ))}

          <p className="text-xs text-muted">
            Matched against supplier product{" "}
            <span className="font-mono">{match.supplierExternalId ?? "unknown"}</span>
            {match.matcherVersion !== null
              ? ` · matcher ${match.matcherVersion}`
              : ""}
          </p>
        </>
      )}
    </SectionShell>
  );
}


function EconomicsSection({ detail }: { detail: ProductDetail }) {
  const economics = detail.economics;
  const currency = economics.currency;

  return (
    <SectionShell
      title="Economics — the deterministic cost breakdown"
      status={economics.status}
      note="One calculation, deterministic at the time it ran. A negative profit is shown as a loss; a field nothing stored is shown as not stored, never as zero. The economics composition version and the selected transit time are not persisted columns, so they read back as unknown."
    >
      {economics.completeness === null ? (
        <EmptyObservation label="No economics calculation is stored for this pairing." />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-sm text-muted">Completeness</span>
            <span className="text-base font-semibold">{economics.completeness}</span>
          </div>

          <DefinitionList>
            <Field label="Selling price" value={money(economics.sellingPrice, currency)} />
            <Field label="Buyer shipping" value={money(economics.buyerShipping, currency)} />
            <Field
              label="Gross marketplace revenue"
              value={money(economics.grossRevenue, currency)}
            />
            <Field
              label="Supplier product cost"
              value={money(economics.supplierProductCost, currency)}
            />
            <Field
              label="Supplier shipping cost"
              value={money(economics.supplierShippingCost, currency)}
            />
            <Field label="Landed supplier cost" value={money(economics.landedCost, currency)} />
            <Field label="Marketplace fee" value={money(economics.marketplaceFee, currency)} />
            <Field
              label="Estimated profit"
              value={
                economics.estimatedProfit === null
                  ? null
                  : `${Number(economics.estimatedProfit) < 0 ? "−" : ""}${money(
                      economics.estimatedProfit.replace(/^-/, ""),
                      currency,
                    )}`
              }
            />
            <Field label="Margin" value={percent(economics.marginPercent)} />
            <Field label="Calculated" value={observedAt(economics.calculatedAt)} />
          </DefinitionList>

          {economics.feeComponents.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Fee breakdown
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {economics.feeComponents.map((component) => (
                  <li key={component.name} className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>{component.label}</span>
                    <span className="text-muted">
                      {money(component.amount, currency)}
                      {component.rate !== null ? ` · ${component.rate}` : ""}
                      {component.note !== null ? ` · ${component.note}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {economics.assumptions.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Assumptions the calculation made
              </h3>
              <ul className="flex flex-col gap-0.5 text-xs text-muted">
                {economics.assumptions.map((assumption) => (
                  <li key={assumption}>· {assumption}</li>
                ))}
              </ul>
            </div>
          )}

          {economics.warnings.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-amber-700 dark:text-amber-400">
              {economics.warnings.map((warning) => (
                <li key={warning}>⚠ {warning}</li>
              ))}
            </ul>
          )}

          <p className="text-xs text-muted">
            Fee engine {economics.feeEngineVersion ?? "unknown"} · rules{" "}
            {economics.feeRuleSource ?? "unknown"} · economics{" "}
            {economics.economicsEngineVersion ?? "unknown"}
          </p>
        </>
      )}
    </SectionShell>
  );
}


function OpportunitySection({ detail }: { detail: ProductDetail }) {
  const opportunity = detail.opportunity;

  return (
    <SectionShell
      title="Opportunity — the score, the evidence confidence, and the why"
      status={opportunity.status}
      note="The Opportunity Engine's own stored verdict. The score and the confidence are computed independently: a high score on weak evidence is reported exactly that way. Every factor, cap and caveat below is the engine's own output — the page invents none of it."
    >
      {opportunity.score === null ? (
        <EmptyObservation label="No opportunity assessment is stored for this scope." />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-semibold tabular-nums">{opportunity.score}</span>
              <span className="text-sm text-muted">/ 100</span>
            </div>
            {opportunity.band !== null && (
              <span className="rounded border border-border px-2 py-0.5 text-xs font-medium uppercase tracking-wide">
                {opportunity.band}
              </span>
            )}
            <div className="flex items-baseline gap-2">
              <span className="text-xs uppercase tracking-wide text-muted">
                Evidence confidence
              </span>
              <span className="text-lg font-medium tabular-nums">
                {opportunity.confidence ?? "unknown"}
              </span>
              {opportunity.confidenceLevel !== null && (
                <span className="text-xs text-muted">{opportunity.confidenceLevel}</span>
              )}
            </div>
          </div>

          {opportunity.explanation.length > 0 && (
            <ol className="flex flex-col gap-1.5 text-sm">
              {opportunity.explanation.map((line, index) => (
                <li key={index} className="flex gap-2">
                  <span className="text-muted tabular-nums">{index + 1}.</span>
                  <span>{line}</span>
                </li>
              ))}
            </ol>
          )}

          {opportunity.factors.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Why the score moved
              </h3>
              <ul className="flex flex-col gap-2 text-sm">
                {opportunity.factors.map((factor) => (
                  <li key={factor.name} className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {factor.label}{" "}
                      <span className="text-muted tabular-nums">
                        ({factor.contribution > 0 ? "+" : ""}
                        {factor.contribution})
                      </span>
                    </span>
                    <span className="text-muted">{factor.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {opportunity.caps.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Hard caps applied
              </h3>
              <ul className="flex flex-col gap-1.5 text-sm">
                {opportunity.caps.map((cap) => (
                  <li key={cap.name} className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {cap.label}{" "}
                      <span className="text-muted tabular-nums">(caps at {cap.cap})</span>
                    </span>
                    <span className="text-muted">{cap.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <OpportunityComponents opportunity={opportunity} />
          <OpportunityDemand opportunity={opportunity} />
          <OpportunityCaveats opportunity={opportunity} />
        </>
      )}
    </SectionShell>
  );
}


function OpportunityComponents({
  opportunity,
}: {
  opportunity: ProductDetail["opportunity"];
}) {
  if (opportunity.components === null) {
    return null;
  }
  const components = opportunity.components;

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
        Component contributions
      </h3>
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {components.economics !== null && (
          <li>
            Economics <span className="tabular-nums">{components.economics.score}</span>
            <span className="text-muted"> · {components.economics.completeness}</span>
          </li>
        )}
        {components.match !== null && (
          <li>
            Match <span className="tabular-nums">{components.match.score}</span>
            <span className="text-muted"> · confidence {components.match.confidence}</span>
          </li>
        )}
        {components.competition !== null && (
          <li>
            Competition <span className="tabular-nums">{components.competition.score}</span>
            <span className="text-muted"> · {components.competition.verdict}</span>
          </li>
        )}
        {components.demand !== null && (
          <li>
            Demand <span className="tabular-nums">{components.demand.score}</span>
            <span className="text-muted"> · {components.demand.verdict}</span>
          </li>
        )}
        {components.dataQuality !== null && (
          <li>
            Data quality{" "}
            <span className="tabular-nums">{components.dataQuality.score}</span>
          </li>
        )}
      </ul>
      {opportunity.componentWeights !== null &&
        Object.keys(opportunity.componentWeights).length > 0 && (
          <p className="text-xs text-muted">
            Published weights:{" "}
            {Object.entries(opportunity.componentWeights)
              .map(([name, weight]) => `${name} ${weight}`)
              .join(" · ")}
            . The blend is not a secret.
          </p>
        )}
    </div>
  );
}

function OpportunityDemand({
  opportunity,
}: {
  opportunity: ProductDetail["opportunity"];
}) {
  if (opportunity.demand === null) {
    return null;
  }
  const demand = opportunity.demand;

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
        Demand — honestly
      </h3>
      <p className="text-sm">
        Verdict: <span className="font-medium">{demand.verdict}</span>
        <span className="text-muted"> · {demand.score} demand points</span>
      </p>
      <p className="text-xs text-muted">
        Inkora has no legitimate units-sold signal. Demand points are never
        manufactured: a verdict of insufficient evidence contributes zero.
      </p>
      {demand.evidence.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted">
          {demand.evidence.map((line) => (
            <li key={line}>· {line}</li>
          ))}
        </ul>
      )}
      {demand.limitations.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted">
          {demand.limitations.map((line) => (
            <li key={line}>· Not observed: {line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}


function OpportunityCaveats({
  opportunity,
}: {
  opportunity: ProductDetail["opportunity"];
}) {
  return (
    <>
      {opportunity.caveats.map((caveat) => (
        <p
          key={caveat}
          className="rounded border border-border bg-muted/5 px-3 py-2 text-xs text-muted"
        >
          {caveat}
        </p>
      ))}
      {opportunity.inputs !== null && (
        <p className="text-xs text-muted">
          Inputs: marketplace observed{" "}
          {observedAt(opportunity.inputs.marketplaceSnapshotObservedAt)} · supplier
          observed {observedAt(opportunity.inputs.supplierSnapshotObservedAt)} ·
          economics {observedAt(opportunity.inputs.economicsCalculatedAt)} · history{" "}
          {opportunity.inputs.historyAvailable
            ? "available"
            : "absent (this assessment had no prior observations to score against)"}
          {opportunity.inputs.competitionQuery !== null
            ? ` · competition relative to “${opportunity.inputs.competitionQuery}”`
            : " · competition query unknown"}
          {opportunity.engineVersion !== null ? ` · engine ${opportunity.engineVersion}` : ""}
          {" · calculated "}
          {observedAt(opportunity.calculatedAt)}
        </p>
      )}
    </>
  );
}


function CompetitionSection({ detail }: { detail: ProductDetail }) {
  const competition = detail.competition;

  return (
    <SectionShell
      title="Competition — the observed marketplace window"
      status={competition.status}
      note="Every figure here is relative to the query named below; without it the numbers mean nothing. The window is what the engine replayed, not a live sweep."
    >
      {competition.evidence === null ? (
        <EmptyObservation label="No competition evidence is stored for this listing." />
      ) : (
        <>
          {competition.query !== null && (
            <p className="text-sm">
              Figures are relative to the query{" "}
              <span className="font-medium">“{competition.query}”</span>; without that
              query they mean nothing.
            </p>
          )}
          <p className="text-sm">
            Verdict: <span className="font-medium">{competition.evidence.verdict}</span>
            <span className="text-muted">
              {" "}· intensity {competition.evidence.intensity} of 100 (higher means more
              competition; the score contribution is the inverse)
            </span>
          </p>
          <DefinitionList>
            <Field
              label="Listings in the sampled window"
              value={competition.evidence.sampleSize.toLocaleString()}
            />
            <Field
              label="Distinct sellers"
              value={competition.evidence.distinctSellers.toLocaleString()}
            />
            <Field
              label="Similarly priced listings"
              value={competition.evidence.similarlyPricedListings.toLocaleString()}
            />
            <Field
              label="Listings in NEW condition"
              value={competition.evidence.newConditionListings.toLocaleString()}
            />
            <Field
              label="Provider-reported total for the query"
              value={
                competition.evidence.searchResultTotal === null
                  ? null
                  : competition.evidence.searchResultTotal.toLocaleString()
              }
            />
          </DefinitionList>
          {competition.evidence.caveats.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-muted">
              {competition.evidence.caveats.map((caveat) => (
                <li key={caveat}>· {caveat}</li>
              ))}
            </ul>
          )}
          {competition.limitations.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-muted">
              {competition.limitations.map((limitation) => (
                <li key={limitation}>· {limitation}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </SectionShell>
  );
}


function HistorySection({ detail }: { detail: ProductDetail }) {
  const history = detail.history;
  const series = history.series;

  return (
    <SectionShell
      title="History — persisted observations and deterministic change"
      status={history.status}
      note={series.note}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
        <span>First seen {observedAt(series.firstSeenAt)}</span>
        <span>Last seen {observedAt(series.lastSeenAt)}</span>
        <span>
          Bounded to the {series.limit.toLocaleString()} most recent observations per
          series
        </span>
      </div>

      {series.assessments.length === 0 &&
      series.marketplaceSnapshots.length === 0 &&
      series.economicsObservations.length === 0 &&
      series.matchObservations.length === 0 ? (
        <EmptyObservation label="No history is stored for this scope yet." />
      ) : (
        <>
          <HistorySeriesList series={series} />
          <HistoryChanges changes={history.changes} />
        </>
      )}
    </SectionShell>
  );
}


function HistorySeriesList({
  series,
}: {
  series: ProductDetail["history"]["series"];
}) {
  return (
    <>
      {series.assessments.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            Opportunity assessments
          </h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {series.assessments.map((assessment) => (
              <li key={assessment.calculatedAt} className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span className="tabular-nums">{assessment.score}</span>
                <span className="font-medium">{assessment.band}</span>
                <span className="text-muted">
                  confidence {assessment.confidence} ({assessment.confidenceLevel})
                </span>
                {assessment.profit !== null && (
                  <span className="text-muted tabular-nums">
                    profit {assessment.profit}
                    {assessment.marginPercent !== null ? ` · ${assessment.marginPercent}%` : ""}
                  </span>
                )}
                <span className="text-muted">
                  match {assessment.matchConfidence} · {assessment.economicsCompleteness}{" "}
                  economics
                </span>
                <span className="text-muted tabular-nums">
                  {observedAt(assessment.calculatedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {series.economicsObservations.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            Economics calculations
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {series.economicsObservations.map((observation) => (
              <li key={observation.calculatedAt} className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span className="text-muted tabular-nums">
                  profit {observation.estimatedProfit ?? "not stored"}
                </span>
                <span className="text-muted tabular-nums">
                  margin {observation.marginPercent ?? "not stored"}
                </span>
                <span className="text-muted">{observation.completeness}</span>
                <span className="text-muted tabular-nums">
                  {observedAt(observation.calculatedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {series.marketplaceSnapshots.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            Marketplace prices
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {series.marketplaceSnapshots.map((snapshot) => (
              <li key={snapshot.observedAt} className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span className="tabular-nums">
                  {money(snapshot.price, snapshot.currency)}
                </span>
                <span className="text-muted">
                  {snapshot.shippingCost === null
                    ? "shipping not stored"
                    : `+ ${money(snapshot.shippingCost, snapshot.shippingCurrency)} shipping`}
                </span>
                <span className="text-muted tabular-nums">
                  {observedAt(snapshot.observedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {series.matchObservations.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            Match verdicts
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {series.matchObservations.map((observation) => (
              <li key={observation.calculatedAt} className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span className="tabular-nums">
                  {observation.confidence} · {observation.confidenceBand}
                </span>
                <span className="text-muted">matcher {observation.matcherVersion}</span>
                <span className="text-muted tabular-nums">
                  {observedAt(observation.calculatedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}


function HistoryChanges({
  changes,
}: {
  changes: ProductDetail["history"]["changes"];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
        What changed since the previous observation
      </h3>
      {changes.noPrevious ? (
        <p className="text-sm text-muted">
          This is the first observation stored for this scope, so there is nothing to
          compare it against — these figures are not “no change”, they are “first seen”.
        </p>
      ) : changes.rows.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing changed between the previous observation and this one.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {changes.rows.map((row) => (
            <li key={row.field} className="flex flex-wrap gap-x-3 gap-y-0.5">
              <span className="font-medium">{row.label}</span>
              <span className="text-muted tabular-nums">
                {row.previous ?? "not stored"} → {row.current ?? "not stored"}
              </span>
              {signedPercent(row.delta) !== null && (
                <span className="tabular-nums">
                  {row.direction === "up" ? "↑" : row.direction === "down" ? "↓" : "→"}{" "}
                  {signedPercent(row.delta)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">{changes.note}</p>
    </div>
  );
}

function FreshnessSection({ detail }: { detail: ProductDetail }) {
  const freshness = detail.freshness;

  return (
    <SectionShell
      title="Freshness — when each fact was observed"
      status={freshness.status}
      note={freshness.note}
    >
      <ul className="flex flex-col gap-1.5 text-sm">
        {freshness.entries.map((entry) => (
          <li
            key={entry.label}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5"
          >
            <span>{entry.label}</span>
            <span className="text-muted tabular-nums">
              {entry.observedAt === null
                ? "never"
                : `${observedAt(entry.observedAt)}${
                    entry.ageHours === null
                      ? ""
                      : ` · ${entry.ageHours.toFixed(1)} h ago`
                  }${entry.stale ? " · STALE" : ""}`}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">
        The stale label uses the project&apos;s existing threshold of{" "}
        {freshness.staleThresholdHours} hours. Product Detail invents no freshness
        window of its own.
      </p>
    </SectionShell>
  );
}
