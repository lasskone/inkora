"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { productDetailHref } from "@/lib/product-detail/product-detail-links";
import type {
  CategoryIntelligence,
  ComponentStatus,
  CrossSellerEvidence,
  ListingChangeReport,
  ListingHistoryStatus,
  PriceDistribution,
  ProductConcentration,
  SellerListing,
  SellerProfile,
  SellerScan,
} from "@/lib/sellers/types";
import type {
  SellerScanErrorCode,
  SellerScanErrorResponse,
  SellerScanSuccessResponse,
} from "@/types/sellers";

/**
 * Seller Scanner — seller-side competitive intelligence.
 *
 * The browser names a seller and a search context and posts nothing else — never
 * a price, a listing object or an evidence verdict. The server scopes the
 * marketplace to that seller, verifies the scoping was honored, and composes the
 * deterministic analysis. This component only renders the already-normalized,
 * provider-independent model (docs/ARCHITECTURE.md §4, §17).
 *
 * Every figure below is a measurement of a bounded, context-scoped *sample*:
 * listed prices are not sales, catalog shape is not performance, and overlap
 * confidence describes the *matching* of titles across sellers, not demand. The
 * limitations the scanner attaches are rendered where they are produced rather
 * than buried at the bottom.
 */

const SCAN_ENDPOINT = "/api/sellers/scan";
const SUGGESTED_QUERY = "wireless earbuds";
const SUGGESTED_SELLER = "musicmagpie";

type ScanStatus = "idle" | "loading" | "error" | "empty" | "results";

interface ErrorPayload {
  status?: string;
  code?: SellerScanErrorCode;
  error?: string;
}

const SCAN_ERROR_COPY: Record<SellerScanErrorCode, string> = {
  INVALID_SELLER: "Enter a seller identifier of 1–64 characters.",
  INVALID_QUERY: "Enter a search context of 1–100 characters.",
  SELLER_NOT_FOUND:
    "The marketplace would not scope results to that seller. The identifier may be wrong, or the seller has no listings in this search context.",
  EBAY_NOT_CONFIGURED:
    "eBay is not configured on this server yet. Add the eBay environment variables and restart.",
  EBAY_AUTH_FAILED:
    "The server could not authenticate with eBay. The credentials or the environment may be wrong.",
  EBAY_UPSTREAM_ERROR: "eBay could not complete the scan just now. Try again.",
  EBAY_RATE_LIMITED: "eBay is rate-limiting this application. Wait a moment, then retry.",
  UPSTREAM_ERROR: "A marketplace call failed partway through this scan. Try again.",
  INTERNAL_ERROR: "Something went wrong while scanning. Please try again.",
};

const BAND_TONE: Record<CrossSellerEvidence["confidenceBand"], string> = {
  HIGH: "border-green-600 text-green-700",
  MEDIUM: "border-amber-600 text-amber-700",
  LOW: "border-red-600 text-red-700",
};

const BAND_COPY: Record<CrossSellerEvidence["confidenceBand"], string> = {
  LOW: "Low — the overlap is unproven",
  MEDIUM: "Medium — a plausible overlap; verify before relying on it",
  HIGH: "High — the listings plausibly describe one product family, nothing more",
};

const BREADTH_COPY: Record<ProductConcentration["catalogBreadth"], string> = {
  narrow: "narrow — dominated by a very few product families",
  mixed: "mixed — a moderate spread of product families",
  broad: "broad — spans many distinct product families",
};

const COMPONENT_TONE: Record<ComponentStatus["status"], string> = {
  ok: "border-green-600 text-green-700",
  unavailable: "border-red-600 text-red-700",
  skipped: "border-border text-muted",
};

const HISTORY_STATUS_COPY: Record<ListingHistoryStatus, string> = {
  "first-observed": "First observation",
  unchanged: "Unchanged since the last observation",
  changed: "Changed since the last observation",
  "not-in-current-sample": "Absent from this sample — not a delisting verdict",
};
export function SellerScanner() {
  const [username, setUsername] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [errorCode, setErrorCode] = useState<SellerScanErrorCode | null>(null);
  const [scan, setScan] = useState<SellerScan | null>(null);

  async function runScan(seller: string, searchContext: string) {
    setStatus("loading");
    setErrorCode(null);
    setScan(null);

    try {
      const response = await fetch(SCAN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: seller, query: searchContext }),
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | SellerScanSuccessResponse
        | SellerScanErrorResponse
        | ErrorPayload;

      if (!response.ok || payload.status !== "ok") {
        const errorPayload = payload as SellerScanErrorResponse | ErrorPayload;
        setErrorCode(errorPayload.code ?? "INTERNAL_ERROR");
        setStatus("error");
        return;
      }

      const success = payload as SellerScanSuccessResponse;
      setScan(success.scan);
      setStatus(success.scan.listings.length === 0 ? "empty" : "results");
    } catch {
      setErrorCode("INTERNAL_ERROR");
      setStatus("error");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const seller = username.trim();
    const searchContext = query.trim();
    if (seller.length === 0) {
      setErrorCode("INVALID_SELLER");
      setStatus("error");
      return;
    }
    if (searchContext.length === 0) {
      setErrorCode("INVALID_QUERY");
      setStatus("error");
      return;
    }
    void runScan(seller, searchContext);
  }

  function handleSuggestion() {
    setUsername(SUGGESTED_SELLER);
    setQuery(SUGGESTED_QUERY);
    void runScan(SUGGESTED_SELLER, SUGGESTED_QUERY);
  }

  const isLoading = status === "loading";
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Seller Scanner</h1>
          <p className="max-w-2xl text-sm text-muted">
            Name an eBay seller and the search context that scopes their listings. The server
            verifies it can actually scope to that seller, then reports catalog shape, pricing
            distribution, category concentration, recent listings, change history, and who else
            lists the same product families. Every count is an observation of a bounded sample —
            never a sales figure.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Seller identifier (e.g. musicmagpie)"
              aria-label="Seller identifier"
              maxLength={64}
              disabled={isLoading}
              className="min-w-0 flex-1 rounded border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-foreground disabled:opacity-60"
            />
            <input
              type="search"
              name="q"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search context (e.g. wireless earbuds)"
              aria-label="Search context scoping the seller scan"
              maxLength={100}
              disabled={isLoading}
              className="min-w-0 flex-1 rounded border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-foreground disabled:opacity-60"
            />
            <button
              type="submit"
              className="shrink-0 rounded bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
              disabled={isLoading}
            >
              {isLoading ? "Scanning…" : "Scan seller"}
            </button>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <button
              type="button"
              onClick={handleSuggestion}
              className="underline-offset-2 hover:underline"
              disabled={isLoading}
            >
              Try &ldquo;{SUGGESTED_SELLER}&rdquo; with &ldquo;{SUGGESTED_QUERY}&rdquo;
            </button>
            <span aria-hidden="true">·</span>
            <span>Marketplace: eBay (Browse API)</span>
          </div>
        </form>
        {status === "loading" && (
          <div
            role="status"
            className="rounded border border-border bg-surface px-4 py-6 text-sm text-muted"
          >
            Scoping eBay to that seller and composing the sample…
          </div>
        )}

        {status === "error" && errorCode !== null && (
          <div
            role="alert"
            className="rounded border border-border bg-surface px-4 py-3 text-sm text-foreground"
          >
            {SCAN_ERROR_COPY[errorCode]}
          </div>
        )}

        {status === "empty" && scan !== null && (
          <div className="rounded border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
            That seller returned no listings in this search context. Nothing was sampled, so no
            analysis was produced.
          </div>
        )}
      </section>

      {status === "results" && scan !== null && (
        <div className="flex flex-col gap-8">
          <ScanSummary scan={scan} />
          <SellerProfilePanel profile={scan.seller} />
          <PricingPanel pricing={scan.pricing} />
          <CategoriesPanel categories={scan.categories} />
          <ConcentrationPanel concentration={scan.concentration} />
          <RecentListingsPanel listings={scan.recentListings} query={query} />
          <ListingChangesPanel report={scan.listingChanges} />
          <CrossSellerEvidencePanel evidence={scan.crossSellerEvidence} />
          <ComponentsPanel components={scan.components} />
          <LimitationsPanel limitations={scan.limitations} />
          <ListingsPanel scan={scan} query={query} />
        </div>
      )}
    </div>
  );
}
function StatRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-1.5 last:border-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="shrink-0 text-sm font-medium text-foreground">
        {value === null || value === undefined || value === "" ? "—" : value}
      </span>
    </div>
  );
}

function PanelHeading({ title, caption }: { title: string; caption?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {caption !== undefined && <p className="text-xs text-muted">{caption}</p>}
    </div>
  );
}

function Limitation({ text }: { text: string }) {
  return (
    <p className="text-xs italic leading-relaxed text-muted">
      <span aria-hidden="true">⚠ </span>
      {text}
    </p>
  );
}

/**
 * Money is passed as decimal strings by the boundary (never floats) and arrives
 * here already rounded to cents by the analysis modules. The browser never
 * re-derives or aggregates a money value.
 */
function formatMoney(amount: string | null, currency: string | null): string {
  if (amount === null) return "—";
  if (currency === null) return amount;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatPercent(value: number | null, digits = 1): string {
  if (value === null) return "—";
  return `${value.toFixed(digits)}%`;
}
function ScanSummary({ scan }: { scan: SellerScan }) {
  const { meta, listingSample, seller, observedAt } = scan;
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Scan summary"
        caption="The server-enforced bounds actually applied, and what it cost to observe this sample."
      />
      <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        <StatRow label="Seller" value={seller.username ?? seller.externalSellerId} />
        <StatRow label="Scanned at" value={new Date(observedAt).toLocaleString()} />
        <StatRow label="Listings sampled" value={String(listingSample.sampledCount)} />
        <StatRow
          label="Observed in context"
          value={listingSample.observedTotal === null ? null : String(listingSample.observedTotal)}
        />
        <StatRow
          label="Sample limit / offset"
          value={`${meta.limits.sampleLimit} / ${listingSample.offset}`}
        />
        <StatRow label="Context query" value={listingSample.contextQuery} />
        <StatRow label="Model version" value={meta.version} />
        <StatRow label="Environment" value={meta.environment} />
        <StatRow label="Upstream eBay searches" value={String(meta.upstreamCalls.ebaySearch)} />
        <StatRow label="Persistence writes" value={String(meta.upstreamCalls.supabaseWrites)} />
        <StatRow label="Elapsed" value={`${meta.elapsedMs} ms`} />
        <StatRow label="Recent-listings limit" value={String(meta.limits.recentLimit)} />
      </div>
    </section>
  );
}

function SellerProfilePanel({ profile }: { profile: SellerProfile }) {
  const seller = profile;
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Seller profile"
        caption="Stable identity plus the fields the marketplace returns verbatim on every item summary."
      />
      <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        <StatRow label="Username" value={seller.username} />
        <StatRow label="External seller ID" value={seller.externalSellerId} />
        <StatRow label="Marketplace" value={seller.marketplace} />
        <StatRow
          label="Feedback score"
          value={seller.feedbackScore === null ? null : seller.feedbackScore.toLocaleString("en-US")}
        />
        <StatRow
          label="Positive feedback"
          value={seller.feedbackPercentage === null ? null : formatPercent(seller.feedbackPercentage, 2)}
        />
        <StatRow
          label="Observed listings in context"
          value={seller.observedListingCount === null ? null : String(seller.observedListingCount)}
        />
        <StatRow label="Sampled listings" value={String(seller.sampledListingCount)} />
        <StatRow label="Observed at" value={new Date(seller.observedAt).toLocaleString()} />
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted">
        <span>
          Feedback fields are <strong className="font-medium text-foreground">official</strong> —
          eBay returns them verbatim.
        </span>
        <span>
          Listing counts are <strong className="font-medium text-foreground">observed</strong> and
          context-bounded: they count how many of this seller&apos;s listings matched the search
          context, never the seller&apos;s whole inventory.
        </span>
      </div>
      {seller.username === null && (
        <Limitation text="The provider emitted no display username for this seller, so the normalized identifier is shown instead." />
      )}
    </section>
  );
}
function PricingPanel({ pricing }: { pricing: PriceDistribution }) {
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Price distribution"
        caption="Statistics over listed prices only — listed prices are never sales data."
      />
      <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        <StatRow label="Listings priced" value={String(pricing.pricedCount)} />
        <StatRow label="Unpriced, excluded" value={String(pricing.unpricedCount)} />
        <StatRow label="Minimum" value={formatMoney(pricing.min, pricing.currency)} />
        <StatRow label="First quartile" value={formatMoney(pricing.quartiles.q1, pricing.currency)} />
        <StatRow label="Median" value={formatMoney(pricing.median, pricing.currency)} />
        <StatRow label="Mean" value={formatMoney(pricing.mean, pricing.currency)} />
        <StatRow label="Third quartile" value={formatMoney(pricing.quartiles.q3, pricing.currency)} />
        <StatRow label="Maximum" value={formatMoney(pricing.max, pricing.currency)} />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {pricing.currencies.length === 0 ? (
          <span className="rounded border border-border px-2 py-0.5 text-xs text-muted">
            no currency
          </span>
        ) : (
          pricing.currencies.map((code) => (
            <span
              key={code}
              className="rounded border border-border px-2 py-0.5 text-xs text-muted"
            >
              {code}
            </span>
          ))
        )}
      </div>
      {pricing.mixedCurrencies && (
        <Limitation text="This sample mixed currencies, so money statistics were refused rather than computed across exchange rates." />
      )}
      {pricing.limitation !== null && <Limitation text={pricing.limitation} />}
    </section>
  );
}

function CategoriesPanel({ categories }: { categories: CategoryIntelligence }) {
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Category concentration"
        caption="Each category's share of the sampled listings — a shape observation, not performance."
      />
      <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        <StatRow label="Distinct categories" value={String(categories.distinctCategoryCount)} />
        <StatRow label="Sampled listings" value={String(categories.sampledListingCount)} />
        <StatRow
          label="Dominant category"
          value={categories.dominantCategory === null ? null : categories.dominantCategory.categoryName}
        />
        <StatRow
          label="Dominant share"
          value={categories.dominantCategory === null ? null : formatPercent(categories.dominantCategory.sharePercent)}
        />
      </div>
      {categories.categories.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {categories.categories.map((category) => (
            <div key={category.categoryId} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-foreground">{category.categoryName}</span>
                <span className="shrink-0 text-muted">
                  {category.listingCount} · {formatPercent(category.sharePercent)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-background">
                <div
                  className="h-full rounded-full bg-foreground"
                  style={{ width: `${Math.min(100, Math.max(0, category.sharePercent))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <Limitation text={categories.limitation} />
    </section>
  );
}
function ConcentrationPanel({ concentration }: { concentration: ProductConcentration }) {
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Catalog concentration"
        caption="Repetition in the sampled catalog. Repetition is evidence of listing practice, never evidence of sales."
      />
      <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        <StatRow label="Distinct title families" value={String(concentration.distinctTitleFamilies)} />
        <StatRow label="Largest family size" value={String(concentration.maxFamilyCount)} />
        <StatRow label="Top family share" value={formatPercent(concentration.topFamilySharePercent)} />
        <StatRow label="Catalog breadth" value={BREADTH_COPY[concentration.catalogBreadth]} />
      </div>
      {concentration.repeatedFamilies.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <h3 className="text-sm font-medium text-foreground">Repeated title families</h3>
          {concentration.repeatedFamilies.map((family) => (
            <div
              key={family.key}
              className="flex items-baseline justify-between gap-4 border-b border-border py-1.5 last:border-0"
            >
              <span className="line-clamp-2 text-sm text-foreground">{family.sampleTitle}</span>
              <span className="shrink-0 text-xs text-muted">
                {family.listingCount} listing{family.listingCount === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      )}
      <Limitation text={concentration.limitation} />
    </section>
  );
}

function RecentListingsPanel({
  listings,
  query,
}: {
  listings: SellerListing[] | null;
  /** The query the seller scan used, so a listing link can replay it. */
  query: string;
}) {
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Recent listings"
        caption="The marketplace's own publication dates, newest first — distinct from Inkora's first-observation time."
      />
      {listings === null ? (
        <Limitation text="This marketplace exposes no trustworthy listing creation date, so recent listings cannot be reported." />
      ) : listings.length === 0 ? (
        <p className="text-sm text-muted">No sampled listing carried a publication date.</p>
      ) : (
        <ul className="flex flex-col gap-2 border-t border-border pt-3">
          {listings.map((listing) => (
            <li key={listing.externalId} className="flex items-baseline justify-between gap-4">
              {query.trim().length > 0 ? (
                <Link
                  href={productDetailHref({ itemId: listing.externalId, query })}
                  className="line-clamp-2 text-sm text-foreground underline-offset-2 hover:underline"
                >
                  {listing.title}
                </Link>
              ) : (
                <span className="line-clamp-2 text-sm text-foreground">{listing.title}</span>
              )}
              <span className="shrink-0 text-xs text-muted">
                {listing.itemCreationDate === null
                  ? "undated"
                  : new Date(listing.itemCreationDate).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function ListingChangesPanel({ report }: { report: ListingChangeReport }) {
  const changed = report.histories.filter((history) => history.status === "changed");
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Change history"
        caption="Comparison against Inkora's own stored observations of the same listings."
      />
      <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted">
        <span>{report.note}</span>
        {report.availability === "no-history" && (
          <Limitation text="No stored history existed to compare against, so every listing is reported as first-observed." />
        )}
        {report.availability === "disabled" && (
          <Limitation text="History comparison is disabled in this environment, so listings were recorded without a comparison verdict." />
        )}
      </div>
      {report.histories.length === 0 ? (
        <p className="text-sm text-muted">No listings were compared in this scan.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {report.histories.map((history) => (
            <li
              key={history.externalId}
              className="flex flex-col gap-1.5 rounded border border-border p-3"
            >
              <div className="flex items-baseline justify-between gap-4">
                <span className="line-clamp-2 text-sm font-medium text-foreground">
                  {history.title}
                </span>
                <span
                  className={`shrink-0 rounded border px-2 py-0.5 text-xs ${
                    history.status === "changed"
                      ? "border-amber-600 text-amber-700"
                      : history.status === "first-observed"
                        ? "border-blue-600 text-blue-700"
                        : "border-border text-muted"
                  }`}
                >
                  {HISTORY_STATUS_COPY[history.status]}
                </span>
              </div>
              {history.changes.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {history.changes.map((change) => (
                    <li key={`${change.externalId}-${change.kind}`} className="text-xs text-muted">
                      <span className="font-medium text-foreground">{change.kind}</span>:{" "}
                      <code className="text-foreground">{change.from ?? "—"}</code> →{" "}
                      <code className="text-foreground">{change.to ?? "—"}</code>
                      <span className="ml-1">
                        ({new Date(change.previousObservedAt).toLocaleDateString()} →{" "}
                        {new Date(change.observedAt).toLocaleDateString()})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {history.firstObservedByInkoraAt !== null && (
                <span className="text-xs text-muted">
                  First seen by Inkora:{" "}
                  {new Date(history.firstObservedByInkoraAt).toLocaleString()} — the
                  marketplace&apos;s own publication date is a different field.
                </span>
              )}
              {history.limitation !== null && <Limitation text={history.limitation} />}
            </li>
          ))}
        </ul>
      )}
      {changed.length === 0 && report.histories.length > 0 && (
        <p className="text-xs text-muted">No listing changed between observations.</p>
      )}
    </section>
  );
}
function CrossSellerEvidencePanel({ evidence }: { evidence: CrossSellerEvidence[] }) {
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Cross-seller evidence"
        caption="Product families this seller lists that other independent sellers also list. Marketplace evidence — never units sold."
      />
      {evidence.length === 0 ? (
        <p className="text-sm text-muted">
          No cross-seller overlap evidence was produced in this scan. Either no family in the sample
          was matched to other sellers, or overlap analysis was skipped for this scan.
        </p>
      ) : (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          {evidence.map((item) => (
            <article
              key={item.productFamilyKey}
              className="flex flex-col gap-2 rounded border border-border p-3"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <h3 className="line-clamp-2 text-sm font-medium text-foreground">
                    {item.seed.title}
                  </h3>
                  <span className="text-xs text-muted">
                    Seed listing {item.seed.externalId} · matched by the bounded query{" "}
                    <code className="text-foreground">{item.discoveryQuery}</code>
                  </span>
                </div>
                <span
                  className={`shrink-0 rounded border px-2 py-0.5 text-xs font-medium ${
                    BAND_TONE[item.confidenceBand]
                  }`}
                >
                  {BAND_COPY[item.confidenceBand]}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                <StatRow label="Confidence score" value={formatPercent(item.confidence, 0)} />
                <StatRow label="Observed listings" value={String(item.observedListings)} />
                <StatRow label="Independent sellers" value={String(item.independentSellers)} />
                <StatRow
                  label="This seller in window"
                  value={item.seedSellerPresent ? "yes" : "no"}
                />
              </div>
              {item.sellerNames.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">Sellers in window:</span>
                  {item.sellerNames.map((name) => (
                    <span
                      key={name}
                      className="rounded border border-border px-2 py-0.5 text-xs text-muted"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              )}
              {item.signals.length > 0 && (
                <div className="flex flex-col gap-1 border-t border-border pt-2">
                  <h4 className="text-xs font-medium text-foreground">Supporting signals</h4>
                  {item.signals.map((signal) => (
                    <div
                      key={signal.name}
                      className="flex items-baseline justify-between gap-4 text-xs text-muted"
                    >
                      <span className="line-clamp-2">{signal.detail}</span>
                      <span
                        className={`shrink-0 font-medium ${
                          signal.contribution >= 0 ? "text-green-700" : "text-red-700"
                        }`}
                      >
                        {signal.contribution >= 0 ? "+" : ""}
                        {signal.contribution}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {item.contradictions.length > 0 && (
                <div className="flex flex-col gap-1 border-t border-border pt-2">
                  <h4 className="text-xs font-medium text-foreground">Contradictions</h4>
                  {item.contradictions.map((contradiction) => (
                    <p key={contradiction} className="line-clamp-2 text-xs text-muted">
                      {contradiction}
                    </p>
                  ))}
                </div>
              )}
              {item.limitations.map((limitation) => (
                <Limitation key={limitation} text={limitation} />
              ))}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
function ComponentsPanel({ components }: { components: ComponentStatus[] }) {
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Scan components"
        caption="Which parts of the scan produced usable evidence, and which were refused or skipped."
      />
      <ul className="flex flex-col gap-2 border-t border-border pt-3">
        {components.map((component) => (
          <li
            key={component.component}
            className="flex items-start justify-between gap-4 border-b border-border py-1.5 last:border-0"
          >
            <span className="line-clamp-2 text-sm text-foreground">{component.component}</span>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span
                className={`rounded border px-2 py-0.5 text-xs font-medium ${
                  COMPONENT_TONE[component.status]
                }`}
              >
                {component.status}
              </span>
              {component.message !== undefined && (
                <span className="text-xs text-muted">{component.message}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LimitationsPanel({ limitations }: { limitations: string[] }) {
  return (
    <section className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
      <PanelHeading
        title="Limitations"
        caption="What this scan deliberately does not claim. Read these before acting on any figure above."
      />
      {limitations.length === 0 ? (
        <p className="text-sm text-muted">No limitations were recorded for this scan.</p>
      ) : (
        <ul className="flex flex-col gap-2 border-t border-border pt-3">
          {limitations.map((limitation) => (
            <li
              key={limitation}
              className="flex items-baseline gap-2 text-xs leading-relaxed text-muted"
            >
              <span aria-hidden="true" className="shrink-0">
                ⚠
              </span>
              <span>{limitation}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function ListingsPanel({ scan, query }: { scan: SellerScan; query: string }) {
  return (
    <section className="flex flex-col gap-3">
      <PanelHeading
        title="Sampled listings"
        caption={`${scan.listingSample.sampledCount} listing${
          scan.listingSample.sampledCount === 1 ? "" : "s"
        } actually returned in this bounded page, unmodified.`}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {scan.listings.map((listing) => (
          <ListingCard
            key={`${listing.marketplace}-${listing.externalId}`}
            listing={listing}
            query={query}
          />
        ))}
      </div>
    </section>
  );
}

function ListingCard({
  listing,
  query,
}: {
  listing: SellerListing;
  /** The query the seller scan used, so the link can replay it on a refresh. */
  query: string;
}) {
  return (
    <article className="flex flex-col gap-2 overflow-hidden rounded border border-border bg-surface p-3">
      <div className="relative aspect-square w-full overflow-hidden rounded bg-background">
        {listing.imageUrl === null ? (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted">
            no image
          </div>
        ) : (
          <Image
            src={listing.imageUrl}
            alt={listing.title}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
            className="object-contain"
          />
        )}
      </div>
      <h3 className="line-clamp-2 text-sm font-medium text-foreground">{listing.title}</h3>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">
          {formatMoney(listing.price, listing.currency)}
        </span>
        {listing.shippingCost !== null && (
          <span className="text-xs text-muted">
            + {formatMoney(listing.shippingCost, listing.shippingCurrency)} shipping
          </span>
        )}
      </div>
      {listing.condition !== null && (
        <span className="text-xs text-muted">{listing.condition}</span>
      )}
      {listing.primaryCategoryName !== null && (
        <span className="line-clamp-1 text-xs text-muted">{listing.primaryCategoryName}</span>
      )}
      {listing.buyingOptions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {listing.buyingOptions.map((option) => (
            <span
              key={option}
              className="rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-muted"
            >
              {option}
            </span>
          ))}
        </div>
      )}
      {listing.itemCreationDate !== null && (
        <span className="text-xs text-muted">
          Listed {new Date(listing.itemCreationDate).toLocaleDateString()}
        </span>
      )}
      {listing.listingUrl !== null && (
        <a
          href={listing.listingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-foreground underline-offset-2 hover:underline"
        >
          View listing on {listing.marketplace}
        </a>
      )}
      {query.trim().length > 0 && (
        <Link
          href={productDetailHref({ itemId: listing.externalId, query })}
          className="text-xs font-medium text-muted underline underline-offset-2 hover:no-underline"
        >
          View opportunity detail →
        </Link>
      )}
    </article>
  );
}
