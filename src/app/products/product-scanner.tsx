"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { MatchCandidate, ConfidenceBand } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type {
  EconomicsErrorCode,
  EconomicsErrorResponse,
  EconomicsSuccessResponse,
} from "@/types/economics";
import type {
  EbayEnvironmentLabel,
  MarketplaceSearchErrorCode,
  MarketplaceSearchSuccessResponse,
} from "@/types/marketplace-search";
import type {
  ProductMatchErrorCode,
  ProductMatchErrorResponse,
  ProductMatchSuccessResponse,
} from "@/types/product-match";
import type {
  ProductHistory,
  ProductHistoryErrorCode,
  ProductHistoryErrorResponse,
  ProductHistorySuccessResponse,
} from "@/types/product-history";

/**
 * Product Scanner — marketplace-side discovery.
 *
 * The UI never talks to eBay directly. Every search goes through the Inkora
 * server route, which owns credentials and normalization; this component only
 * renders the already-normalized, provider-independent model.
 */

const SEARCH_ENDPOINT = "/api/marketplaces/ebay/search";
const MATCH_ENDPOINT = "/api/products/matches";
const ECONOMICS_ENDPOINT = "/api/products/economics";
const HISTORY_ENDPOINT = "/api/products/history";
const SUGGESTED_QUERY = "wireless earbuds";

type SearchStatus = "idle" | "loading" | "error" | "empty" | "results";

type HistoryStatus = "idle" | "loading" | "error" | "empty" | "disabled" | "ready";

interface HistoryState {
  itemId: string;
  status: HistoryStatus;
  result?: ProductHistory;
  errorCode?: ProductHistoryErrorCode;
}

interface ErrorPayload {
  status?: string;
  code?: MarketplaceSearchErrorCode | ProductMatchErrorCode;
  error?: string;
}

const ERROR_COPY: Record<MarketplaceSearchErrorCode, string> = {
  INVALID_QUERY: "Enter a search term of 1–100 characters.",
  INVALID_LIMIT: "The requested result limit is not valid.",
  EBAY_NOT_CONFIGURED:
    "eBay search is not configured on this server yet. Add the eBay environment variables and restart.",
  EBAY_AUTH_FAILED:
    "The server could not authenticate with eBay. The credentials or the environment may be wrong.",
  EBAY_UPSTREAM_ERROR:
    "eBay could not complete the search just now. Try again.",
  EBAY_RATE_LIMITED:
    "eBay is rate-limiting this application. Wait a moment, then retry.",
  INTERNAL_ERROR: "Something went wrong while searching. Please try again.",
};

const MATCH_ERROR_COPY: Record<ProductMatchErrorCode, string> = {
  INVALID_ITEM_ID: "That listing could not be identified.",
  INVALID_QUERY: "The search term used to find this listing is not valid.",
  INVALID_LIMIT: "The requested candidate limit is not valid.",
  EBAY_NOT_CONFIGURED:
    "eBay search is not configured on this server, so the listing cannot be re-resolved.",
  EBAY_AUTH_FAILED:
    "The server could not authenticate with eBay while re-resolving this listing.",
  EBAY_UPSTREAM_ERROR: "eBay could not re-resolve this listing just now.",
  EBAY_RATE_LIMITED:
    "eBay is rate-limiting this application. Try again shortly.",
  ITEM_NOT_RESOLVED:
    "This listing is no longer in the current search results. Re-run the search, then try again.",
  CJ_NOT_CONFIGURED:
    "CJdropshipping is not configured on this server, so no supplier candidates can be found.",
  CJ_AUTH_FAILED:
    "The server could not authenticate with CJdropshipping while searching for candidates.",
  CJ_UPSTREAM_ERROR:
    "CJdropshipping could not complete the search just now. Try again.",
  CJ_RATE_LIMITED:
    "CJdropshipping is rate-limiting this application. Wait a moment, then retry.",
  INTERNAL_ERROR:
    "Something went wrong while looking for supplier candidates. Please try again.",
};

const HISTORY_ERROR_COPY: Record<ProductHistoryErrorCode, string> = {
  INVALID_ITEM_ID: "That listing could not be identified.",
  INVALID_LIMIT: "The requested history limit is not valid.",
  HISTORY_NOT_CONFIGURED:
    "Historical observations are not enabled on this server, so nothing has been persisted yet.",
  NO_OBSERVATIONS:
    "No observations have been persisted for this listing yet. Observations are recorded when economics are evaluated.",
  HISTORY_UNAVAILABLE: "History could not be read just now. Try again.",
  INTERNAL_ERROR: "Something went wrong while reading history. Please try again.",
};

const BAND_COPY: Record<MatchCandidate["confidenceBand"], string> = {
  LOW: "Low confidence — likely a related but different product",
  MEDIUM: "Medium confidence — plausible candidate, verify before relying on it",
  HIGH: "High confidence — strong textual correspondence, not a guarantee",
};

const INVENTORY_COPY: Record<
  NonNullable<MatchCandidate["usWarehouseInventory"]>,
  string
> = {
  CONFIRMED_AVAILABLE: "US warehouse: in stock",
  CONFIRMED_NONE: "US warehouse: none confirmed",
  UNKNOWN: "US warehouse: unknown",
};

type MatchStatus = "idle" | "loading" | "error" | "ready";

interface MatchState {
  itemId: string;
  status: MatchStatus;
  result?: ProductMatchSuccessResponse;
  errorCode?: ProductMatchErrorCode;
}

type EconomicsStatus = "idle" | "loading" | "error" | "ready";

interface EconomicsState {
  status: EconomicsStatus;
  result?: EconomicsResult;
  /** Confidence band the server reported for the candidate it actually costed. */
  matchConfidenceBand?: ConfidenceBand;
  errorCode?: EconomicsErrorCode;
}

/**
 * Economics are fetched per candidate, so the panel state is keyed by the
 * candidate identity rather than held as a single value.
 */
type EconomicsStore = Record<string, EconomicsState>;

const ECONOMICS_ERROR_COPY: Record<EconomicsErrorCode, string> = {
  INVALID_ITEM_ID: "That listing could not be identified.",
  INVALID_QUERY: "The search term used to find this listing is not valid.",
  INVALID_SUPPLIER_PRODUCT_ID: "That supplier product could not be identified.",
  INVALID_DESTINATION:
    "The shipping destination configured on this server is not usable.",
  EBAY_NOT_CONFIGURED:
    "eBay search is not configured on this server, so the listing cannot be re-resolved.",
  EBAY_AUTH_FAILED:
    "The server could not authenticate with eBay while re-resolving this listing.",
  EBAY_UPSTREAM_ERROR: "eBay could not re-resolve this listing just now.",
  EBAY_RATE_LIMITED: "eBay is rate-limiting this application. Try again shortly.",
  ITEM_NOT_RESOLVED:
    "This listing is no longer in the current search results. Re-run the search, then try again.",
  CANDIDATE_NOT_FOUND:
    "The matcher no longer surfaces this candidate, so its economics cannot be recomputed.",
  CJ_NOT_CONFIGURED:
    "CJdropshipping is not configured on this server, so no supplier cost or shipping quote can be obtained.",
  CJ_AUTH_FAILED:
    "The server could not authenticate with CJdropshipping while costing this candidate.",
  CJ_UPSTREAM_ERROR:
    "CJdropshipping could not return a cost or freight quote just now. Try again.",
  CJ_RATE_LIMITED:
    "CJdropshipping is rate-limiting this application. Wait a moment, then retry.",
  INTERNAL_ERROR:
    "Something went wrong while computing economics. Please try again.",
};

export function ProductScanner() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [errorCode, setErrorCode] = useState<MarketplaceSearchErrorCode | null>(
    null,
  );
  const [products, setProducts] = useState<MarketplaceProduct[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [environment, setEnvironment] = useState<EbayEnvironmentLabel | null>(
    null,
  );
  // The term that produced the current results; the matcher needs it to
  // re-resolve the listing server-side.
  const [searchedQuery, setSearchedQuery] = useState("");
  const [match, setMatch] = useState<MatchState | null>(null);
  const [economics, setEconomics] = useState<EconomicsStore>({});
  const [history, setHistory] = useState<HistoryState | null>(null);

  async function runSearch(searchTerm: string) {
    setStatus("loading");
    setErrorCode(null);

    try {
      const response = await fetch(
        `${SEARCH_ENDPOINT}?q=${encodeURIComponent(searchTerm)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as
        | MarketplaceSearchSuccessResponse
        | ErrorPayload;

      if (!response.ok || payload.status !== "ok") {
        // The eBay search route can only emit marketplace error codes.
        setErrorCode(
          ((payload as ErrorPayload).code ?? "INTERNAL_ERROR") as MarketplaceSearchErrorCode,
        );
        setStatus("error");
        return;
      }

      const success = payload as MarketplaceSearchSuccessResponse;
      setEnvironment(success.environment);
      setTotal(success.total);
      setProducts(success.products);
      setSearchedQuery(searchTerm);
      setMatch(null);
      setEconomics({});
      setStatus(success.products.length === 0 ? "empty" : "results");
    } catch {
      setErrorCode("INTERNAL_ERROR");
      setStatus("error");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setErrorCode("INVALID_QUERY");
      setStatus("error");
      return;
    }
    void runSearch(trimmed);
  }

  function handleSuggestion() {
    setQuery(SUGGESTED_QUERY);
    void runSearch(SUGGESTED_QUERY);
  }

  async function runMatch(product: MarketplaceProduct) {
    setMatch({ itemId: product.externalId, status: "loading" });

    const params = new URLSearchParams({
      itemId: product.externalId,
      q: searchedQuery,
    });

    try {
      const response = await fetch(`${MATCH_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | ProductMatchSuccessResponse
        | ProductMatchErrorResponse;

      if (!response.ok || payload.status !== "ok") {
        const errorPayload = payload as ProductMatchErrorResponse;
        setMatch({
          itemId: product.externalId,
          status: "error",
          errorCode: errorPayload.code ?? "INTERNAL_ERROR",
        });
        return;
      }

      setMatch({
        itemId: product.externalId,
        status: "ready",
        result: payload as ProductMatchSuccessResponse,
      });
    } catch {
      setMatch({
        itemId: product.externalId,
        status: "error",
        errorCode: "INTERNAL_ERROR",
      });
    }
  }

  function matchStatusFor(itemId: string): MatchStatus {
    return match && match.itemId === itemId ? match.status : "idle";
  }

  function closeMatch() {
    setMatch(null);
  }

  /**
   * Reads the persisted observations for one listing. History is a separate read
   * path with its own boundary: it never receives credentials, and every figure
   * it shows is an observation with its own timestamp, not a live quote.
   */
  async function runHistory(itemId: string) {
    setHistory({ itemId, status: "loading" });

    try {
      const response = await fetch(
        `${HISTORY_ENDPOINT}?itemId=${encodeURIComponent(itemId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as
        | ProductHistorySuccessResponse
        | ProductHistoryErrorResponse;

      if (!response.ok) {
        const errorPayload = payload as ProductHistoryErrorResponse;
        setHistory({
          itemId,
          status: errorPayload.code === "NO_OBSERVATIONS" ? "empty" : "error",
          errorCode: errorPayload.code,
        });
        return;
      }

      if (payload.status !== "ok") {
        // A non-conforming body must never render as though it were history.
        setHistory({ itemId, status: "error", errorCode: "INTERNAL_ERROR" });
        return;
      }

      setHistory({
        itemId,
        status: "ready",
        result: payload.history,
      });
    } catch {
      setHistory({ itemId, status: "error", errorCode: "INTERNAL_ERROR" });
    }
  }

  function historyStateFor(itemId: string): HistoryState {
    if (history !== null && history.itemId === itemId) {
      return history;
    }
    return { itemId, status: "idle" };
  }

  /**
   * Economics state is keyed by listing + supplier product, so a stale panel is
   * never shown next to a candidate it was not computed for.
   */
  function economicsKey(itemId: string, supplierProductId: string): string {
    return `${itemId}::${supplierProductId}`;
  }

  async function runEconomics(
    itemId: string,
    supplierProductId: string,
  ) {
    const key = economicsKey(itemId, supplierProductId);
    setEconomics((previous) => ({ ...previous, [key]: { status: "loading" } }));

    const params = new URLSearchParams({
      itemId,
      q: searchedQuery,
      supplierProductId,
    });

    try {
      const response = await fetch(`${ECONOMICS_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | EconomicsSuccessResponse
        | EconomicsErrorResponse;

      if (!response.ok || payload.status !== "ok") {
        const errorPayload = payload as EconomicsErrorResponse;
        setEconomics((previous) => ({
          ...previous,
          [key]: {
            status: "error",
            errorCode: errorPayload.code ?? "INTERNAL_ERROR",
          },
        }));
        return;
      }

      const success = payload as EconomicsSuccessResponse;
      setEconomics((previous) => ({
        ...previous,
        [key]: {
          status: "ready",
          result: success.economics,
          matchConfidenceBand: success.matchConfidenceBand,
        },
      }));
    } catch {
      setEconomics((previous) => ({
        ...previous,
        [key]: { status: "error", errorCode: "INTERNAL_ERROR" },
      }));
    }
  }

  function economicsFor(
    itemId: string,
    supplierProductId: string,
  ): EconomicsState {
    return economics[economicsKey(itemId, supplierProductId)] ?? { status: "idle" };
  }

  const isLoading = status === "loading";

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Product Scanner
          </h1>
          <p className="text-muted max-w-2xl">
            Search live eBay marketplace listings by keyword. Results come
            through the Inkora server, normalized into Inkora&apos;s marketplace
            model.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 sm:flex-row"
        >
          <input
            type="search"
            name="q"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. wireless earbuds"
            maxLength={100}
            disabled={isLoading}
            aria-label="Search eBay listings"
            className="flex-1 rounded-md border border-border bg-surface px-4 py-2.5 text-sm outline-none placeholder:text-muted focus:border-foreground disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-5 py-2.5 text-sm font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Searching…" : "Search"}
          </button>
        </form>

        {status === "idle" && (
          <p className="text-sm text-muted">
            No search yet. Try{" "}
            <button
              type="button"
              onClick={handleSuggestion}
              className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
            >
              {SUGGESTED_QUERY}
            </button>
            .
          </p>
        )}

        {status === "loading" && (
          <p className="text-sm text-muted" role="status">
            Searching eBay for &ldquo;{query.trim()}&rdquo;…
          </p>
        )}

        {status === "error" && errorCode !== null && (
          <div
            role="alert"
            className="rounded-md border border-border bg-surface px-4 py-3 text-sm text-foreground"
          >
            {ERROR_COPY[errorCode]}
          </div>
        )}

        {status === "empty" && (
          <p className="text-sm text-muted">
            No eBay listings found for &ldquo;{query.trim()}&rdquo;. Try a
            different or broader keyword.
          </p>
        )}

        {status === "results" && (
          <p className="text-sm text-muted">
            Showing {products.length}
            {total !== null ? ` of ${total}` : ""} eBay listings for &ldquo;
            {query.trim()}&rdquo;
            {environment ? ` · ${environment}` : ""}.
          </p>
        )}
      </section>

      {status === "results" && (
        <section aria-label="Supplier candidates">
          {match && (
            <SupplierMatchPanel
              state={match}
              onClose={closeMatch}
              economicsFor={(supplierProductId) =>
                economicsFor(match.itemId, supplierProductId)
              }
              onCalculateEconomics={(supplierProductId) =>
                runEconomics(match.itemId, supplierProductId)
              }
              historyState={historyStateFor(match.itemId)}
              onShowHistory={() => runHistory(match.itemId)}
            />
          )}
        </section>
      )}

      {status === "results" && (
        <section aria-label="Search results">
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <li key={`${product.marketplace}-${product.externalId}`}>
                <ProductCard
                  product={product}
                  matchStatus={matchStatusFor(product.externalId)}
                  onFindSupplier={() => runMatch(product)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface ProductCardProps {
  product: MarketplaceProduct;
  matchStatus: MatchStatus;
  onFindSupplier: () => void;
}

function ProductCard({ product, matchStatus, onFindSupplier }: ProductCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const isMatching = matchStatus === "loading";

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="relative aspect-square w-full border-b border-border bg-background">
        {product.imageUrl && !imageFailed ? (
          <Image
            src={product.imageUrl}
            alt={product.title}
            fill
            sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw"
            className="object-contain p-3"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            No image
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1.5">
          {product.listingUrl ? (
            <a
              href={product.listingUrl}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="line-clamp-2 text-sm font-medium leading-snug hover:underline"
            >
              {product.title}
            </a>
          ) : (
            <h3 className="line-clamp-2 text-sm font-medium leading-snug">
              {product.title}
            </h3>
          )}

          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="rounded border border-border px-1.5 py-0.5 font-medium uppercase">
              eBay
            </span>
            {product.condition && (
              <span className="rounded border border-border px-1.5 py-0.5 uppercase">
                {product.condition}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            {product.price !== null ? (
              <span className="font-semibold">
                {formatMoney(product.price, product.currency)}
              </span>
            ) : (
              <span className="text-muted">Price not listed</span>
            )}

            {product.shippingCost !== null ? (
              <span className="text-xs text-muted">
                {isZeroAmount(product.shippingCost)
                  ? "Free shipping"
                  : `+ ${formatMoney(
                      product.shippingCost,
                      product.shippingCurrency,
                    )} shipping`}
              </span>
            ) : (
              <span className="text-xs text-muted">Shipping not listed</span>
            )}
          </div>

          <div className="text-xs text-muted">
            {product.sellerName ? (
              <span>
                Seller: {product.sellerName}
                {product.sellerFeedbackPercentage !== null
                  ? ` · ${product.sellerFeedbackPercentage}% feedback`
                  : ""}
              </span>
            ) : (
              <span>Seller not listed</span>
            )}
          </div>

          {product.location && (
            <div className="text-xs text-muted">
              Located in {product.location}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onFindSupplier}
          disabled={isMatching}
          aria-busy={isMatching}
          className="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isMatching ? "Searching suppliers…" : "Find supplier"}
        </button>

        <div className="mt-auto pt-1 text-[11px] uppercase tracking-wide text-muted">
          Source: eBay API · {product.provenance}
        </div>
      </div>
    </article>
  );
}

function formatMoney(value: string, currency: string | null): string {
  if (currency === "USD") {
    return `$${value}`;
  }
  return currency ? `${value} ${currency}` : value;
}

function isZeroAmount(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

function SupplierMatchPanel({
  state,
  onClose,
  economicsFor,
  onCalculateEconomics,
  historyState,
  onShowHistory,
}: {
  state: MatchState;
  onClose: () => void;
  economicsFor: (supplierProductId: string) => EconomicsState;
  onCalculateEconomics: (supplierProductId: string) => void;
  historyState: HistoryState;
  onShowHistory: () => void;
}) {
  if (state.status === "loading") {
    return (
      <div
        role="status"
        className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted"
      >
        Searching CJdropshipping for supplier candidates…
      </div>
    );
  }

  if (state.status === "error" || !state.result) {
    const code = state.errorCode ?? "INTERNAL_ERROR";
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-4">
        <div role="alert" className="text-sm text-foreground">
          {MATCH_ERROR_COPY[code]}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="self-start text-xs font-medium text-muted underline underline-offset-2 hover:no-underline"
        >
          Dismiss
        </button>
      </div>
    );
  }

  const { result } = state;
  const marketplace = result.marketplaceProduct;

  return (
    <div className="flex flex-col gap-5 rounded-lg border border-border bg-surface px-4 py-5 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Supplier candidates
          </h2>
          <p className="text-xs text-muted">
            Ranked by deterministic text matching. Confidence is estimated by
            Inkora — it is not an eBay or CJdropshipping fact.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={onShowHistory}
            disabled={historyState.status === "loading"}
            aria-busy={historyState.status === "loading"}
            className="text-xs font-medium text-muted underline underline-offset-2 hover:no-underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            {historyState.status === "loading" ? "Loading history…" : "History"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-medium text-muted underline underline-offset-2 hover:no-underline"
          >
            Close
          </button>
        </div>
      </div>

      {historyState.status === "loading" && (
        <div
          role="status"
          className="rounded-md border border-border bg-background px-3 py-3 text-xs text-muted"
        >
          Reading the persisted observations for this listing…
        </div>
      )}

      {(historyState.status === "error" ||
        historyState.status === "empty" ||
        historyState.status === "disabled") && (
        <div
          role={historyState.status === "empty" ? "status" : "alert"}
          className="rounded-md border border-border bg-background px-3 py-3 text-xs text-foreground"
        >
          {HISTORY_ERROR_COPY[historyState.errorCode ?? "INTERNAL_ERROR"]}
        </div>
      )}

      {historyState.status === "ready" && historyState.result && (
        <HistoryPanel history={historyState.result} />
      )}

      <div className="flex gap-4 border-b border-border pb-4">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-md border border-border bg-background">
          {marketplace.imageUrl ? (
            <Image
              src={marketplace.imageUrl}
              alt={marketplace.title}
              fill
              sizes="96px"
              className="object-contain p-2"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[10px] text-muted">
              No image
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            eBay listing
          </div>
          {marketplace.listingUrl ? (
            <a
              href={marketplace.listingUrl}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="line-clamp-2 text-sm font-medium hover:underline"
            >
              {marketplace.title}
            </a>
          ) : (
            <div className="line-clamp-2 text-sm font-medium">
              {marketplace.title}
            </div>
          )}
          <div className="text-xs text-muted">
            {marketplace.price !== null
              ? formatMoney(marketplace.price, marketplace.currency)
              : "Price not listed"}{" "}
            · Source: eBay API · {marketplace.provenance}
          </div>
        </div>
      </div>

      <div className="text-xs text-muted">
        Searched CJdropshipping for:{" "}
        {result.queries.map((entry) => entry.query).join(" · ") || "—"}
      </div>

      {result.candidates.length === 0 ? (
        <p className="text-sm text-muted">
          No CJdropshipping candidates surfaced for this listing. This is an
          honest &ldquo;no strong match&rdquo; result, not an error.
          {result.queries.some((entry) => entry.failure !== null) && (
            <> Some supplier queries failed; see below.</>
          )}
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {result.candidates.map((candidate, index) => (
            <li key={`${candidate.supplierProduct.externalId}-${index}`}>
              <CandidateCard
                candidate={candidate}
                rank={index + 1}
                economicsState={economicsFor(candidate.supplierProduct.externalId)}
                onCalculateEconomics={() =>
                  onCalculateEconomics(candidate.supplierProduct.externalId)
                }
              />
            </li>
          ))}
        </ol>
      )}

      {result.queries.some((entry) => entry.failure !== null) && (
        <div className="flex flex-col gap-1 text-xs text-muted">
          <span className="font-medium">Supplier query failures</span>
          {result.queries
            .filter((entry) => entry.failure !== null)
            .map((entry) => (
              <span key={entry.query}>
                &ldquo;{entry.query}&rdquo; — {entry.failure}
              </span>
            ))}
        </div>
      )}

      <p className="text-[11px] text-muted">
        Candidate discovery bounded to {result.limits.maxQueries} CJdropshipping
        queries, {result.limits.maxCandidates} scored candidates, and{" "}
        {result.limits.maxInventoryLookups} inventory lookups. Price is never
        used as identity evidence.
      </p>
    </div>
  );
}

function CandidateCard({
  candidate,
  rank,
  economicsState,
  onCalculateEconomics,
}: {
  candidate: MatchCandidate;
  rank: number;
  economicsState: EconomicsState;
  onCalculateEconomics: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const supplier = candidate.supplierProduct;
  const showImage = supplier.imageUrl !== null && !imageFailed;
  const isCalculating = economicsState.status === "loading";

  return (
    <article className="flex flex-col gap-3 rounded-md border border-border bg-background p-4">
      <div className="flex gap-4">
        <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-md border border-border bg-surface">
          {showImage ? (
            <Image
              src={supplier.imageUrl as string}
              alt=""
              fill
              sizes="112px"
              className="object-contain p-2"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[10px] text-muted">
              No image
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-semibold text-muted">#{rank}</span>
            <span className="text-[11px] uppercase tracking-wide text-muted">
              CJdropshipping
            </span>
          </div>
          <h3 className="line-clamp-2 text-sm font-medium leading-snug">
            {supplier.title}
          </h3>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold">{candidate.confidence}/100</span>
            <span
              className={`rounded border px-1.5 py-0.5 font-medium uppercase ${
                candidate.confidenceBand === "HIGH"
                  ? "border-green-600 text-green-700"
                  : candidate.confidenceBand === "MEDIUM"
                    ? "border-amber-600 text-amber-700"
                    : "border-border text-muted"
              }`}
            >
              {candidate.confidenceBand}
            </span>
            {supplier.supplierPrice !== null ? (
              <span className="text-muted">
                Supplier cost{" "}
                {formatMoney(supplier.supplierPrice, supplier.currency)}
              </span>
            ) : (
              <span className="text-muted">Supplier cost not listed</span>
            )}
            {candidate.usWarehouseInventory !== null ? (
              <span className="rounded border border-border px-1.5 py-0.5 text-muted">
                {INVENTORY_COPY[candidate.usWarehouseInventory]}
              </span>
            ) : (
              <span className="text-muted">US warehouse: not queried</span>
            )}
          </div>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-foreground">
        {candidate.explanation}
      </p>

      {candidate.signals.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Positive signals
          </div>
          <ul className="flex flex-col gap-0.5">
            {candidate.signals.slice(0, 3).map((signal) => (
              <li key={signal.name} className="text-xs text-muted">
                <span className="font-medium text-foreground">
                  +{signal.contribution}
                </span>{" "}
                {signal.label} — {signal.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {candidate.contradictions.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-red-700">
            Contradictions
          </div>
          <ul className="flex flex-col gap-0.5">
            {candidate.contradictions.map((entry) => (
              <li key={entry.name} className="text-xs text-red-700/90">
                <span className="font-medium uppercase">
                  {entry.severity} cap {entry.cap}
                </span>{" "}
                {entry.label} — {entry.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onCalculateEconomics}
          disabled={isCalculating}
          aria-busy={isCalculating}
          className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isCalculating ? "Calculating economics…" : "Calculate economics"}
        </button>

        {economicsState.status === "error" && (
          <div role="alert" className="text-xs text-red-700">
            {ECONOMICS_ERROR_COPY[economicsState.errorCode ?? "INTERNAL_ERROR"]}
          </div>
        )}
      </div>

      {economicsState.status === "loading" && (
        <div
          role="status"
          className="rounded-md border border-border bg-surface px-3 py-3 text-xs text-muted"
        >
          Resolving the CJdropshipping variant and quoting freight to the
          baseline destination…
        </div>
      )}

      {economicsState.status === "ready" && economicsState.result && (
        <EconomicsPanel
          economics={economicsState.result}
          matchConfidenceBand={economicsState.matchConfidenceBand ?? null}
        />
      )}

      <p className="text-[11px] text-muted">
        {BAND_COPY[candidate.confidenceBand]} · provenance{" "}
        {candidate.confidenceProvenance}
      </p>
    </article>
  );
}


function HistoryPanel({ history }: { history: ProductHistory }) {
  const identity = history.marketplaceProduct;
  const hasAny =
    history.marketplaceSnapshots.length > 0 ||
    history.matchObservations.length > 0 ||
    history.economicsObservations.length > 0;

  return (
    <section
      aria-label="Persisted history"
      className="flex flex-col gap-3 rounded-md border border-border bg-background px-4 py-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Persisted history</h3>
        <p className="text-[11px] text-muted">
          Every figure below is an observation Inkora stored at the timestamp it
          carries. None of them describes the listing now — current prices and
          matches are the live figures shown above.
        </p>
        <p className="text-[11px] text-muted">
          Anchored to eBay item {identity.externalId} · first seen{" "}
          {identity.firstSeenAt} · last seen {identity.lastSeenAt}
        </p>
      </div>

      {!hasAny && (
        <p className="text-[11px] text-muted">
          This listing has an identity but no stored observations yet.
        </p>
      )}

      {history.marketplaceSnapshots.length > 0 && (
        <details open className="flex flex-col gap-1.5">
          <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wide text-muted">
            Observed prices · {history.marketplaceSnapshots.length} entr
            {history.marketplaceSnapshots.length === 1 ? "y" : "ies"}
          </summary>
          <ul className="flex flex-col gap-1.5">
            {history.marketplaceSnapshots.map((snapshot, index) => (
              <li
                key={`${snapshot.observedAt}-${index}`}
                className="flex items-baseline justify-between gap-2 border-l border-border pl-2 text-[11px]"
              >
                <span className="text-muted">{snapshot.observedAt}</span>
                <span className="font-medium">
                  {snapshot.price !== null
                    ? formatMoney(snapshot.price, snapshot.currency)
                    : "No price observed"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {history.matchObservations.length > 0 && (
        <details className="flex flex-col gap-1.5">
          <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wide text-muted">
            Match observations · {history.matchObservations.length} entr
            {history.matchObservations.length === 1 ? "y" : "ies"}
          </summary>
          <ul className="flex flex-col gap-1.5">
            {history.matchObservations.map((observation, index) => (
              <li
                key={`${observation.calculatedAt}-${index}`}
                className="flex items-baseline justify-between gap-2 border-l border-border pl-2 text-[11px]"
              >
                <span className="text-muted">
                  {observation.calculatedAt} · v{observation.matcherVersion}
                </span>
                <span className="font-medium">
                  {(observation.confidence * 100).toFixed(1)}% ·{" "}
                  {observation.confidenceBand}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-muted">
            Supplier ids are CJ product {history.matchObservations
              .map((observation) => observation.supplierExternalId ?? "unknown")
              .filter((value, index, array) => array.indexOf(value) === index)
              .join(", ")}
          </p>
        </details>
      )}

      {history.economicsObservations.length > 0 && (
        <details className="flex flex-col gap-1.5">
          <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wide text-muted">
            Economics observations · {history.economicsObservations.length} entr
            {history.economicsObservations.length === 1 ? "y" : "ies"}
          </summary>
          <ul className="flex flex-col gap-1.5">
            {history.economicsObservations.map((observation, index) => (
              <li
                key={`${observation.calculatedAt}-${index}`}
                className="flex flex-col gap-0.5 border-l border-border pl-2 text-[11px]"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-muted">{observation.calculatedAt}</span>
                  <span
                    className={
                      observation.estimatedProfit !== null &&
                      Number(observation.estimatedProfit) < 0
                        ? "font-medium text-red-700"
                        : "font-medium"
                    }
                  >
                    {observation.estimatedProfit !== null
                      ? `${observation.estimatedProfit} profit`
                      : "No profit computed"}
                  </span>
                </div>
                <span className="text-muted">
                  item {observation.itemPrice ?? "—"} · landed{" "}
                  {observation.landedCost ?? "—"} · fee{" "}
                  {observation.marketplaceFee ?? "—"} · margin{" "}
                  {observation.marginPercent ?? "—"}% ·{" "}
                  {observation.completeness} · fee engine v
                  {observation.feeEngineVersion}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const COMPLETENESS_COPY: Record<EconomicsResult["completeness"], string> = {
  COMPLETE: "Complete — every required input was resolved",
  PARTIAL: "Partial — profit is computable but rests on an assumed input",
  UNAVAILABLE:
    "Unavailable — a required input is missing, so no profit is shown",
};

const COMPLETENESS_TONE: Record<EconomicsResult["completeness"], string> = {
  COMPLETE: "border-green-600 text-green-700",
  PARTIAL: "border-amber-600 text-amber-700",
  UNAVAILABLE: "border-red-600 text-red-700",
};

const COST_BASIS_COPY: Record<
  NonNullable<EconomicsResult["supplierCostBasis"]>,
  string
> = {
  SELECTED_VARIANT: "resolved variant cost (definitive)",
  VARIANT_REFERENCE: "reference variant cost (identity unresolved)",
  CATALOG_MINIMUM: "catalogue minimum cost (a lower bound)",
};


function EconomicsPanel({
  economics,
  matchConfidenceBand,
}: {
  economics: EconomicsResult;
  matchConfidenceBand: ConfidenceBand | null;
}) {
  const negativeProfit =
    economics.estimatedProfit !== null && Number(economics.estimatedProfit) < 0;

  return (
    <section
      aria-label="Economics breakdown"
      className="flex flex-col gap-3 rounded-md border border-border bg-surface px-3 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide">
          Economics
        </h4>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${COMPLETENESS_TONE[economics.completeness]}`}
        >
          {economics.completeness}
        </span>
      </div>

      <p className="text-[11px] text-muted">
        {COMPLETENESS_COPY[economics.completeness]}
      </p>

      <dl className="flex flex-col gap-1 text-xs">
        <MoneyRow
          label="Item price"
          value={economics.itemPrice}
          currency={economics.currency}
          provenance={economics.provenance.itemPrice}
        />
        <MoneyRow
          label="Buyer-paid shipping"
          value={economics.buyerShipping}
          currency={economics.currency}
          provenance={economics.provenance.buyerShipping}
          fallback="not priced by eBay"
        />
        <MoneyRow
          label="Gross revenue"
          value={economics.grossMarketplaceRevenue}
          currency={economics.currency}
          provenance="ESTIMATED"
          emphasize
        />
        <MoneyRow
          label="CJ product cost"
          value={economics.supplierProductCost}
          currency={economics.currency}
          provenance={economics.provenance.supplierProductCost}
          fallback="not resolvable"
        />
        <MoneyRow
          label="CJ shipping"
          value={economics.supplierShippingCost}
          currency={economics.currency}
          provenance={economics.provenance.supplierShippingCost}
          fallback="no quote returned"
        />
        <MoneyRow
          label="Landed cost"
          value={economics.landedSupplierCost}
          currency={economics.currency}
          provenance="ESTIMATED"
          emphasize
        />
        <MoneyRow
          label="Marketplace fee"
          value={economics.marketplaceFee}
          currency={economics.currency}
          provenance={economics.provenance.marketplaceFee}
          fallback="not computable"
        />
        <MoneyRow
          label="Estimated profit"
          value={economics.estimatedProfit}
          currency={economics.currency}
          provenance={economics.provenance.estimatedProfit}
          fallback="not computable"
          emphasize
          danger={negativeProfit}
        />
        <div className="flex items-baseline justify-between gap-2 pt-1">
          <dt className="text-muted">Margin</dt>
          <dd
            className={`font-semibold ${negativeProfit ? "text-red-700" : ""}`}
          >
            {economics.marginPercent !== null
              ? `${economics.marginPercent}%`
              : "not computable"}
          </dd>
        </div>
      </dl>

      {negativeProfit && (
        <p className="text-[11px] font-medium text-red-700">
          This listing sells for less than it costs to source and ship. Negative
          profit is reported as-is, never clamped to zero.
        </p>
      )}

      {economics.supplierCostBasis !== null && (
        <p className="text-[11px] text-muted">
          Cost basis: {COST_BASIS_COPY[economics.supplierCostBasis]}
          {economics.selectedVariant !== null && (
            <>
              {" · variant "}
              <span className="font-medium text-foreground">
                {economics.selectedVariant.title ??
                  economics.selectedVariant.sku ??
                  economics.selectedVariant.externalId}
              </span>
            </>
          )}
        </p>
      )}

      {economics.supplierShippingMethod !== null && (
        <p className="text-[11px] text-muted">
          Shipping method:{" "}
          <span className="font-medium text-foreground">
            {economics.supplierShippingMethod}
          </span>
          {economics.supplierShippingTransitTime !== null && (
            <> · transit {economics.supplierShippingTransitTime} days</>
          )}{" "}
          · to {economics.shippingDestination.label}
        </p>
      )}


      {economics.feeBreakdown.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted">
            Fee breakdown · status {economics.feeStatus} · engine v
            {economics.feeEngineVersion}
          </div>
          {economics.feeBreakdown.map((component) => (
            <div
              key={component.name}
              className="flex items-baseline justify-between gap-2 text-[11px]"
            >
              <span className="text-muted">
                {component.label}
                {component.rate !== null ? ` @ ${component.rate}` : ""}
              </span>
              <span className="font-medium">{component.amount ?? "—"}</span>
            </div>
          ))}
          <p className="text-[10px] text-muted">{economics.feeRuleSource}</p>
        </div>
      )}

      {matchConfidenceBand === "LOW" && (
        <p className="rounded border border-amber-600 px-2 py-1.5 text-[11px] text-amber-700">
          Low-confidence caveat: the server only weakly associates this eBay
          listing with this supplier product. The figures are arithmetically
          sound but may describe two different products — verify the match
          before relying on them.
        </p>
      )}

      {economics.warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-amber-700">
            Warnings
          </div>
          <ul className="flex flex-col gap-0.5">
            {economics.warnings.map((warning, index) => (
              <li key={index} className="text-[11px] text-foreground">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="flex flex-col gap-1">
        <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wide text-muted">
          Assumptions
        </summary>
        <ul className="flex flex-col gap-0.5">
          {economics.assumptions.map((assumption, index) => (
            <li key={index} className="text-[11px] text-muted">
              {assumption}
            </li>
          ))}
        </ul>
        <p className="text-[10px] text-muted">
          Computed {economics.calculatedAt} · eBay item{" "}
          {economics.marketplaceItemId} · CJ product {economics.supplierProductId}{" "}
          · {economics.shippingQuotes.length} freight quote
          {economics.shippingQuotes.length === 1 ? "" : "s"} returned
        </p>
      </details>
    </section>
  );
}

function MoneyRow({
  label,
  value,
  currency,
  provenance,
  fallback,
  emphasize,
  danger,
}: {
  label: string;
  value: string | null;
  currency: string | null;
  provenance: string;
  fallback?: string;
  emphasize?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted">
        {label}{" "}
        <span className="text-[9px] uppercase tracking-wide text-muted/70">
          {provenance.toLowerCase()}
        </span>
      </dt>
      <dd
        className={[
          emphasize ? "font-semibold" : "font-medium",
          danger ? "text-red-700" : "",
          value === null ? "font-normal italic text-muted" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value === null
          ? fallback ?? "unavailable"
          : formatMoney(value, currency)}
      </dd>
    </div>
  );
}

