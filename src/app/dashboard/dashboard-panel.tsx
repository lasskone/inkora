"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { formatMoney } from "@/app/products/product-scanner";
import type { DashboardSuccessResponse } from "@/types/dashboard";
import type { DashboardErrorResponse } from "@/types/dashboard";
import type {
  ActivityEvent,
  AttentionItem,
  DashboardChangeRow,
  DashboardData,
  DashboardSortKey,
  FreshnessEntry,
  SectionStatus,
  TopOpportunityRow,
  WatchlistPreviewRow,
} from "@/lib/dashboard/types";

/**
 * The Dashboard — a read-only aggregation surface over intelligence INKORA has
 * already computed and persisted (docs/MVP_SPEC.md §4.1,
 * docs/ARCHITECTURE.md §19).
 *
 * Every number on this page is a stored observation with its own timestamp, or a
 * value derived deterministically from stored observations (a count, a band
 * tally, a previous-vs-current comparison). Nothing here re-scores, re-matches or
 * re-prices, and a page load performs no eBay, CJ or freight call.
 *
 * Filters, sort and page size live in the URL, so every control is a link: a
 * Dashboard state is a shareable deep link, back and forward work, and there is
 * no client state to keep in sync with the server's echo of what was applied.
 */

const ENDPOINT = "/api/dashboard";

const SORT_LABELS: Record<DashboardSortKey, string> = {
  score: "Opportunity score",
  confidence: "Evidence confidence",
  profit: "Estimated profit",
  margin: "Margin",
  match: "Match confidence",
  "recently-evaluated": "Last evaluated first",
};

const LIMIT_OPTIONS = [6, 12, 24, 50];

interface FilterControl {
  param: string;
  label: string;
  values: readonly string[];
}

const FILTER_CONTROLS: readonly FilterControl[] = [
  { param: "band", label: "Opportunity band", values: ["LOW", "MEDIUM", "HIGH"] },
  { param: "evidence", label: "Evidence", values: ["LOW", "MEDIUM", "HIGH"] },
  { param: "match", label: "Match", values: ["LOW", "MEDIUM", "HIGH"] },
  {
    param: "economics",
    label: "Economics",
    values: ["COMPLETE", "PARTIAL", "UNAVAILABLE"],
  },
  {
    param: "profitability",
    label: "Profitability",
    values: ["profitable", "losing", "unknown"],
  },
  { param: "supplierScope", label: "Supplier scope", values: ["pair", "marketplace-only"] },
  { param: "watchState", label: "Watch state", values: ["watched", "unwatched"] },
];

type LoadStatus = "loading" | "ready" | "not-configured" | "error";

interface LoadState {
  status: LoadStatus;
  data?: DashboardData;
  appliedKey?: string;
  errorMessage?: string;
}

/**
 * The query string the boundary receives, built from the page's own search
 * params. Only the controls the boundary knows are forwarded, so an unrelated
 * parameter in a shared link can never reach the request.
 */
function buildEndpointQuery(search: URLSearchParams): string {
  const forwarded = new URLSearchParams();
  for (const key of [
    "limit",
    "sort",
    "band",
    "evidence",
    "match",
    "economics",
    "profitability",
    "supplierScope",
    "watchState",
  ]) {
    const value = search.get(key);
    if (value !== null) {
      forwarded.set(key, value);
    }
  }
  const query = forwarded.toString();
  return query.length > 0 ? `${ENDPOINT}?${query}` : ENDPOINT;
}

/**
 * Builds a deep link with one control changed. Re-setting a value the URL
 * already holds *removes* it, so every filter chip is its own toggle and the
 * unfiltered page is always one click away.
 */
function controlHref(
  search: URLSearchParams,
  param: string,
  value: string,
): string {
  const next = new URLSearchParams(search);
  if (next.get(param) === value) {
    next.delete(param);
  } else {
    next.set(param, value);
  }
  const query = next.toString();
  return query.length > 0 ? `/dashboard?${query}` : "/dashboard";
}

/** Replaces one control's value rather than toggling it (sort and page size). */
function replaceHref(search: URLSearchParams, param: string, value: string): string {
  const next = new URLSearchParams(search);
  next.set(param, value);
  return `/dashboard?${next.toString()}`;
}

/** Clears every filter, leaving sort and page size in place. */
function clearFiltersHref(search: URLSearchParams): string {
  const next = new URLSearchParams(search);
  for (const control of FILTER_CONTROLS) {
    next.delete(control.param);
  }
  const query = next.toString();
  return query.length > 0 ? `/dashboard?${query}` : "/dashboard";
}

/** True when any filter is currently narrowing the page. */
function hasFilters(search: URLSearchParams): boolean {
  return FILTER_CONTROLS.some((control) => search.has(control.param));
}

/**
 * Renders a persisted timestamp as a stable, locale-independent label, so a
 * reader can always see that a figure is a point-in-time fact rather than a live
 * claim about a listing&#39;s present state.
 */
function observedAt(iso: string | null): string {
  if (iso === null) {
    return "not observed yet";
  }
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/** Renders an age in hours as a short, stable label. */
function ageLabel(hours: number | null): string {
  if (hours === null) {
    return "unknown";
  }
  if (hours < 1) {
    return "under an hour ago";
  }
  if (hours < 48) {
    return `${Math.round(hours)} h ago`;
  }
  return `${Math.round(hours / 24)} d ago`;
}

const STATUS_LABEL: Record<SectionStatus, string> = {
  available: "available",
  partial: "partial — some evidence is missing",
  unavailable: "unavailable — no evidence was read for this section",
};
export function DashboardPanel() {
  const search = useSearchParams();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const endpoint = buildEndpointQuery(search);
  // Re-fetch only when the *forwarded* query changes, so an unrelated search
  // parameter does not trigger a reload.
  const appliedKey = endpoint;

  const load = useCallback(async () => {
    setState((previous) => ({
      ...previous,
      status: previous.data === undefined ? "loading" : previous.status,
    }));
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (response.status === 503) {
        setState({ status: "not-configured", appliedKey });
        return;
      }
      if (!response.ok) {
        const errorBody = (await response
          .json()
          .catch(() => null)) as DashboardErrorResponse | null;
        setState({
          status: "error",
          appliedKey,
          errorMessage: errorBody?.error ?? "The Dashboard could not be loaded.",
        });
        return;
      }
      const body = (await response.json()) as DashboardSuccessResponse;
      // A param change may have started a newer load while this one was in flight;
      // the older response is dropped rather than rendered over the newer one.
      setState((previous) =>
        previous.appliedKey !== appliedKey
          ? previous
          : { status: "ready", data: body.dashboard, appliedKey },
      );
    } catch {
      setState((previous) =>
        previous.appliedKey !== appliedKey
          ? previous
          : {
              status: "error",
              appliedKey,
              errorMessage: "The Dashboard request did not complete.",
            },
      );
    }
  }, [endpoint, appliedKey]);

  /**
   * Initial read plus a re-read whenever the forwarded query changes. This is a
   * one-shot read of an external system, so the reading state flips before the
   * first await: the state it sets replaces the rendered Dashboard rather than
   * deriving from it, so there is no cascading render to avoid — same shape as
   * the watchlist panel (`src/app/watchlist/watchlist-panel.tsx`).
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (state.status === "loading" || state.data === undefined) {
    if (state.status === "not-configured") {
      return <NotConfigured />;
    }
    if (state.status === "error") {
      return <ErrorState message={state.errorMessage} onRetry={load} />;
    }
    return (
      <div
        role="status"
        className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted"
      >
        Reading the persisted intelligence for this Dashboard…
      </div>
    );
  }

  return <DashboardContent data={state.data} search={search} />;
}

function DashboardContent({
  data,
  search,
}: {
  data: DashboardData;
  search: URLSearchParams;
}) {
  return (
    <div className="flex flex-col gap-10">
      {!data.hasIntelligence ? (
        <NoIntelligence data={data} />
      ) : (
        <>
          <SummarySection data={data} />
          <TopOpportunitiesSection data={data} search={search} />
          <AttentionSection data={data} />
          <RecentChangesSection data={data} />
          <WatchlistSection data={data} />
          <CoverageSection data={data} />
          <ActivitySection data={data} />
          <FreshnessSection data={data} />
        </>
      )}
      {data.warnings.length > 0 ? <WarningsSection data={data} /> : null}
    </div>
  );
}

function WarningsSection({ data }: { data: DashboardData }) {
  return (
    <section
      aria-labelledby="dashboard-warnings"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-4"
    >
      <h2 id="dashboard-warnings" className="text-sm font-medium text-amber-800">
        Sections reporting no evidence
      </h2>
      <ul className="mt-2 flex flex-col gap-1 text-[12px] text-amber-800">
        {data.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </section>
  );
}

/** The honest empty page: persistence is reachable but holds nothing yet. */
function NoIntelligence({ data }: { data: DashboardData }) {
  return (
    <section
      aria-labelledby="dashboard-empty"
      className="rounded-lg border border-border bg-surface px-6 py-10"
    >
      <h2 id="dashboard-empty" className="text-base font-medium">
        No intelligence is stored yet
      </h2>
      <p className="mt-2 text-sm text-muted">
        The Dashboard summarizes assessments INKORA has already computed and
        persisted. Nothing has been evaluated yet, so there is no opportunity to
        rank, no change to report and no freshness to measure — run a scan first.
      </p>
      <ul className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <li>
          <Link href="/products" className="font-medium text-foreground underline">
            Product Scanner
          </Link>
        </li>
        <li>
          <Link href="/sellers" className="font-medium text-foreground underline">
            Seller Scanner
          </Link>
        </li>
        <li>
          <Link href="/watchlist" className="font-medium text-foreground underline">
            Watchlist
          </Link>
        </li>
      </ul>
      <p className="mt-6 text-[12px] text-muted">
        Watchlist entries stored: {data.summary.watchedOpportunities} · assessments
        persisted: {data.summary.persistedAssessments}.
      </p>
    </section>
  );
}

function NotConfigured() {
  return (
    <section
      aria-labelledby="dashboard-disabled"
      className="rounded-lg border border-border bg-surface px-6 py-10"
    >
      <h2 id="dashboard-disabled" className="text-base font-medium">
        Persistence is not configured
      </h2>
      <p className="mt-2 text-sm text-muted">
        The Dashboard reads intelligence that INKORA has already persisted, and
        this server has no persistence configured, so there is nothing to
        summarize. Set{" "}
        <code className="font-mono text-[12px]">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono text-[12px]">SUPABASE_SERVICE_ROLE_KEY</code> to
        record history.
      </p>
    </section>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <section
      aria-labelledby="dashboard-error"
      className="rounded-lg border border-border bg-surface px-6 py-10"
    >
      <h2 id="dashboard-error" className="text-base font-medium">
        The Dashboard could not be loaded
      </h2>
      <p className="mt-2 text-sm text-muted">
        {message ?? "The request did not complete."} A partially-read Dashboard is
        normally still returned with the sections that could be assembled, so
        this is a request-level failure rather than a degraded section.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-background"
      >
        Try again
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared section chrome
// ---------------------------------------------------------------------------

/**
 * Every section renders its own status, so a page whose watchlist evidence is
 * absent still shows the summary, the changes feed and the freshness panel
 * beside an honest "unavailable" (docs/ARCHITECTURE.md §19.7).
 */
function SectionShell({
  id,
  title,
  status,
  note,
  children,
}: {
  id: string;
  title: string;
  status: SectionStatus;
  note: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border border-border bg-surface px-5 py-5"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 id={id} className="text-base font-medium">
          {title}
        </h2>
        <span
          className={[
            "w-fit rounded-full px-2.5 py-0.5 text-[11px] font-medium",
            status === "available"
              ? "bg-green-50 text-green-800"
              : status === "partial"
                ? "bg-amber-50 text-amber-800"
                : "bg-red-50 text-red-800",
          ].join(" ")}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>
      <p className="mt-2 text-[12px] text-muted">{note}</p>
      {children}
    </section>
  );
}

/** A KPI card that never shows a fabricated figure for a missing one. */
function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-background px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint !== undefined ? (
        <div className="mt-0.5 text-[11px] text-muted">{hint}</div>
      ) : null}
    </div>
  );
}

/** A three-value distribution bar, so a tally reads as a share, not just a count. */
function Distribution({
  tally,
}: {
  tally: { HIGH: number; MEDIUM: number; LOW: number } | {
      COMPLETE: number;
      PARTIAL: number;
      UNAVAILABLE: number;
    };
}) {
  const entries = Object.entries(tally) as [string, number][];
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) {
    return <p className="text-[12px] text-muted">No assessments in this window.</p>;
  }
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {entries.map(([key, count]) => (
        <div key={key} className="flex items-center gap-3 text-[12px]">
          <span className="w-28 shrink-0 text-muted">{key}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-background">
            <div
              className="h-full rounded-full bg-foreground/70"
              style={{ width: `${(count / total) * 100}%` }}
            />
          </div>
          <span className="w-16 shrink-0 text-right tabular-nums">
            {count} ({Math.round((count / total) * 100)}%)
          </span>
        </div>
      ))}
    </div>
  );
}

function SummarySection({ data }: { data: DashboardData }) {
  const summary = data.summary;
  return (
    <SectionShell
      id="dashboard-summary"
      title="Summary"
      status={summary.status}
      note={summary.note}
    >
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Kpi
          label="Evaluated opportunities"
          value={summary.evaluatedOpportunities}
          hint="Scopes whose latest assessment is inside the read window"
        />
        <Kpi
          label="Persisted assessments"
          value={summary.persistedAssessments}
          hint="Every assessment ever stored, exact count"
        />
        <Kpi
          label="Watched"
          value={summary.watchedOpportunities}
          hint="Active watchlist entries, whole table"
        />
        <Kpi
          label="Needs attention"
          value={summary.needsAttention}
          hint="Named conditions, derived — no severity"
        />
        <Kpi label="Profitable" value={summary.profitable} hint="Profit above zero" />
        <Kpi label="Losing" value={summary.losing} hint="Profit below zero" />
        <Kpi
          label="Profit unknown"
          value={summary.profitUnknown}
          hint="Never read as zero"
        />
      </div>
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div>
          <h3 className="text-[12px] font-medium">Opportunity bands</h3>
          <Distribution tally={summary.bands} />
        </div>
        <div>
          <h3 className="text-[12px] font-medium">Evidence confidence</h3>
          <Distribution tally={summary.evidenceConfidence} />
        </div>
        <div>
          <h3 className="text-[12px] font-medium">Economics completeness</h3>
          <Distribution tally={summary.economicsCompleteness} />
        </div>
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Top opportunities — filters, sort and page size, all in the URL
// ---------------------------------------------------------------------------

function ControlLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={[
        "rounded-full border px-3 py-1 text-[12px]",
        active
          ? "border-foreground bg-foreground text-background font-medium"
          : "border-border bg-surface text-muted hover:text-foreground",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}

function TopOpportunitiesSection({
  data,
  search,
}: {
  data: DashboardData;
  search: URLSearchParams;
}) {
  const section = data.topOpportunities;
  const activeSort = search.get("sort") ?? "score";
  const activeLimit = Number(search.get("limit") ?? section.limit);

  return (
    <SectionShell
      id="dashboard-opportunities"
      title="Top opportunities"
      status={section.status}
      note={section.note}
    >
      <div className="mt-4 flex flex-col gap-3">
        <FilterControls search={search} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted">Sort</span>
          {(Object.keys(SORT_LABELS) as DashboardSortKey[]).map((key) => (
            <ControlLink
              key={key}
              href={replaceHref(search, "sort", key)}
              active={activeSort === key}
            >
              {SORT_LABELS[key]}
            </ControlLink>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted">Page size</span>
          {LIMIT_OPTIONS.map((value) => (
            <ControlLink
              key={value}
              href={replaceHref(search, "limit", String(value))}
              active={activeLimit === value}
            >
              {value}
            </ControlLink>
          ))}
        </div>
      </div>

      {hasFilters(search) ? (
        <div className="mt-3">
          <Link
            href={clearFiltersHref(search)}
            className="text-[12px] font-medium text-foreground underline"
          >
            Clear every filter
          </Link>
        </div>
      ) : null}

      {section.rows.length === 0 ? (
        <p className="mt-5 text-sm text-muted">
          {section.filteredCount === 0
            ? "No opportunity in the read window matches. A scope whose last assessment predates the window is not represented on this page."
            : "Every opportunity in the read window was filtered out. Loosen a filter to see them."}
        </p>
      ) : (
        <OpportunitiesTable section={section} />
      )}
      <p className="mt-3 text-[11px] text-muted">
        Showing {section.rows.length} of {section.filteredCount} matching scopes.
        Every figure is one assessment&#39;s stored value; the ranking introduces no
        weighting of its own.
      </p>
    </SectionShell>
  );
}

function OpportunitiesTable({
  section,
}: {
  section: DashboardData["topOpportunities"];
}) {
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-[12px]">
        <caption className="sr-only">
          Ranked by {SORT_LABELS[section.sort]} — {section.rows.length} of{" "}
          {section.filteredCount} matching scopes, page size {section.limit}.
        </caption>
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">
              Listing
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Supplier
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Score
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Confidence
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Profit
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Margin
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Watched
            </th>
          </tr>
        </thead>
        <tbody>
          {section.rows.map((row) => (
            <OpportunityRow key={scopeRowKey(row)} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A stable key for one row, including the marketplace-only scope. */
function scopeRowKey(row: TopOpportunityRow): string {
  return `${row.scope.marketplaceExternalId}|${row.scope.supplierExternalId ?? "-"}`;
}

function OpportunityRow({ row }: { row: TopOpportunityRow }) {
  const { scope, market } = row;
  const title = market?.title ?? null;
  return (
    <tr className="border-b border-border align-top">
      <td className="py-3 pr-3">
        <div className="flex items-start gap-3">
          {market?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={market.imageUrl}
              alt={title === null ? "Listing thumbnail" : `Thumbnail for ${title}`}
              className="h-10 w-10 shrink-0 rounded border border-border object-cover"
              loading="lazy"
            />
          ) : null}
          <div className="flex flex-col gap-0.5">
            {row.detailHref ? (
              <Link
                href={row.detailHref}
                className="font-medium text-foreground underline underline-offset-2"
              >
                {title ?? "Title not stored"}
              </Link>
            ) : (
              <span className="font-medium text-foreground">
                {title ?? "Title not stored"}
              </span>
            )}
            <span className="text-muted">
              {market?.price !== null && market?.price !== undefined
                ? formatMoney(market.price, market.currency ?? null)
                : "price not stored"}
              {market?.observedAt
                ? ` · observed ${ageFromIso(market.observedAt)}`
                : ""}
            </span>
            <span className="text-muted">{scope.marketplaceExternalId}</span>
          </div>
        </div>
      </td>
      <td className="py-3 pr-3 text-muted">
        {scope.supplierExternalId ?? "none — marketplace-only scope"}
      </td>
      <td className="py-3 pr-3 text-right font-medium tabular-nums">
        {scope.score}
        <span className="ml-1 text-muted">{scope.band}</span>
      </td>
      <td className="py-3 pr-3 text-right tabular-nums">
        {scope.confidence}
        <span className="ml-1 text-muted">{scope.confidenceLevel}</span>
      </td>
      <td className="py-3 pr-3 text-right tabular-nums">
        {scope.estimatedProfit === null
          ? "unavailable"
          : formatMoney(scope.estimatedProfit, market?.currency ?? null)}
      </td>
      <td className="py-3 pr-3 text-right tabular-nums">
        {scope.marginPercent === null ? "unavailable" : `${scope.marginPercent}%`}
      </td>
      <td className="py-3 pr-3">{row.watched ? "watched" : "—"}</td>
    </tr>
  );
}

/** Age label straight from a stored timestamp, so freshness is never asserted. */
function ageFromIso(iso: string): string {
  return ageLabel((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

/**
 * Every filter, each value a link. A value the URL already holds is un-set by
 * the same link, so the chips are toggles and the unfiltered page is always one
 * click away — and the applied set is always visible, because it *is* the URL.
 */
function FilterControls({ search }: { search: URLSearchParams }) {
  return (
    <div className="flex flex-col gap-2">
      {FILTER_CONTROLS.map((control) => (
        <div key={control.param} className="flex flex-wrap items-center gap-2">
          <span className="w-32 shrink-0 text-[12px] text-muted">{control.label}</span>
          {control.values.map((value) => (
            <ControlLink
              key={value}
              href={controlHref(search, control.param, value)}
              active={search.get(control.param) === value}
            >
              {value}
            </ControlLink>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs attention — named reasons, no invented severity
// ---------------------------------------------------------------------------

function AttentionSection({ data }: { data: DashboardData }) {
  const section = data.attention;
  return (
    <SectionShell
      id="dashboard-attention"
      title="Needs attention"
      status={section.status}
      note={section.note}
    >
      {section.items.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          No scope in the window meets a named attention condition. Nothing here is
          a verdict on the whole page — an empty list means the engines recorded no
          low-confidence, unavailable-economics or changed-watch condition.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {section.items.map((item) => (
            <AttentionRow key={attentionKey(item)} item={item} />
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-muted">
        Bounded to {section.limit} items. Position comes from the engine&#39;s score
        under the same ladder every list uses — the Dashboard invents no priority.
      </p>
    </SectionShell>
  );
}

function attentionKey(item: AttentionItem): string {
  return `${item.scope.marketplaceExternalId}|${item.scope.supplierExternalId ?? "-"}`;
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const title = item.market?.title ?? item.scope.marketplaceExternalId;
  return (
    <li className="rounded-md border border-border bg-background px-4 py-3">
      <div className="flex flex-col gap-1">
        {item.detailHref ? (
          <Link
            href={item.detailHref}
            className="w-fit font-medium text-foreground underline underline-offset-2"
          >
            {title}
          </Link>
        ) : (
          <span className="font-medium text-foreground">{title}</span>
        )}
        <span className="text-[11px] text-muted">
          score {item.scope.score} ({item.scope.band}) · confidence{" "}
          {item.scope.confidence} ({item.scope.confidenceLevel}) ·{" "}
          {item.scope.supplierExternalId === null
            ? "marketplace-only scope"
            : item.scope.supplierExternalId}
        </span>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {item.reasons.map((reason) => (
            <li key={reason.code} className="text-[12px] text-foreground">
              <span className="font-mono text-[11px] text-muted">{reason.code}</span>
              <span className="ml-1.5">{reason.message}</span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Recent changes — previous vs current, never a trend
// ---------------------------------------------------------------------------

function RecentChangesSection({ data }: { data: DashboardData }) {
  const section = data.changes;
  return (
    <SectionShell
      id="dashboard-changes"
      title="Recent changes"
      status={section.status}
      note={section.note}
    >
      {section.changes.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          No scope in the window has both a current and a previous assessment. A
          first evaluation has nothing to compare against, so it appears here only
          when it is re-evaluated.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {section.changes.map((change) => (
            <li
              key={`${change.scope.marketplaceExternalId}|${change.scope.supplierExternalId ?? "-"}`}
              className="rounded-md border border-border bg-background px-4 py-3"
            >
              <div className="flex flex-col gap-1">
                {change.detailHref ? (
                  <Link
                    href={change.detailHref}
                    className="w-fit font-medium text-foreground underline underline-offset-2"
                  >
                    {change.market?.title ?? change.scope.marketplaceExternalId}
                  </Link>
                ) : (
                  <span className="font-medium text-foreground">
                    {change.market?.title ?? change.scope.marketplaceExternalId}
                  </span>
                )}
                <span className="text-[11px] text-muted">
                  compared at {observedAt(change.calculatedAt)}
                </span>
                <ChangeRows
                  rows={change.rows}
                  currency={change.market?.currency ?? null}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-muted">
        Bounded to {section.limit} scopes. Each row is a single previous-to-current
        comparison — a single delta is not a trend.
      </p>
    </SectionShell>
  );
}

function ChangeRows({
  rows,
  currency,
}: {
  rows: DashboardChangeRow[];
  currency: string | null;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-muted">
        No field could be compared — the assessment is stored without comparable
        values.
      </p>
    );
  }
  return (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full min-w-[460px] border-collapse text-[11px]">
        <caption className="sr-only">
          Previous versus current values. Money fields carry a signed delta.
        </caption>
      <thead>
        <tr className="border-b border-border text-left text-muted">
          <th scope="col" className="py-1.5 pr-3 font-medium">
            Field
          </th>
          <th scope="col" className="py-1.5 pr-3 font-medium">
            Previous
          </th>
          <th scope="col" className="py-1.5 pr-3 font-medium">
            Current
          </th>
          <th scope="col" className="py-1.5 pr-3 font-medium">
            Delta
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.field} className="border-b border-border">
            <td className="py-1.5 pr-3">{row.label}</td>
            <td className="py-1.5 pr-3 tabular-nums">
              {formatChangeValue(row.previous, currency, row.field)}
            </td>
            <td className="py-1.5 pr-3 tabular-nums">
              {formatChangeValue(row.current, currency, row.field)}
            </td>
            <td className="py-1.5 pr-3 tabular-nums">
              {row.direction === "unknown" ? (
                <span className="text-muted">unknown — a side is missing</span>
              ) : (
                `${row.delta === null ? "—" : formatMoney(row.delta, currency)} (${row.direction})`
              )}
            </td>
          </tr>
        ))}
      </tbody>
      </table>
    </div>
  );
}

/** Money fields are formatted; band fields are shown as names, not numbers. */
function formatChangeValue(
  value: string | null,
  currency: string | null,
  field: string,
): string {
  if (value === null) {
    return "—";
  }
  return field === "estimatedProfit" ? formatMoney(value, currency) : value;
}

// ---------------------------------------------------------------------------
// Watchlist summary — counts plus a bounded preview
// ---------------------------------------------------------------------------

function WatchlistSection({ data }: { data: DashboardData }) {
  const section = data.watchlist;
  return (
    <SectionShell
      id="dashboard-watchlist"
      title="Watchlist summary"
      status={section.status}
      note={section.note}
    >
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Active entries" value={section.activeCount} hint="Whole table" />
        <Kpi
          label="Marketplace-only"
          value={section.marketplaceOnlyCount}
          hint="A NULL supplier is a scope"
        />
        <Kpi
          label="Changed"
          value={section.changedCount}
          hint="Latest differs from previous"
        />
        <Kpi
          label="Preview"
          value={section.preview.length}
          hint={`Bounded to ${section.limit}`}
        />
      </div>
      {section.preview.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          No active watchlist entries. Monitoring is manual on purpose — add a
          scope from Product Detail or the scanners.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {section.preview.map((entry) => (
            <WatchlistPreviewRowItem key={entry.entryId} entry={entry} />
          ))}
        </ul>
      )}
      <div className="mt-4">
        <Link
          href="/watchlist"
          className="text-[12px] font-medium text-foreground underline"
        >
          Open the full watchlist
        </Link>
      </div>
    </SectionShell>
  );
}

function WatchlistPreviewRowItem({
  entry,
}: {
  entry: WatchlistPreviewRow;
}) {
  const assessment = entry.assessment;
  return (
    <li className="rounded-md border border-border bg-background px-4 py-3">
      <div className="flex flex-col gap-1">
        {entry.detailHref ? (
          <Link
            href={entry.detailHref}
            className="w-fit font-medium text-foreground underline underline-offset-2"
          >
            {entry.label ?? entry.marketplaceExternalId}
          </Link>
        ) : (
          <span className="font-medium text-foreground">
            {entry.label ?? entry.marketplaceExternalId}
          </span>
        )}
        <span className="text-[11px] text-muted">
          {entry.supplierExternalId === null
            ? "marketplace-only scope"
            : entry.supplierExternalId}{" "}
          · added {observedAt(entry.createdAt)} · updated{" "}
          {observedAt(entry.updatedAt)}
        </span>
        {assessment === null ? (
          <span className="text-[11px] text-muted">no assessment stored yet</span>
        ) : (
          <span className="text-[11px] tabular-nums">
            score {assessment.score} ({assessment.band}) · confidence{" "}
            {assessment.confidence} ({assessment.confidenceLevel}) · evaluated{" "}
            {observedAt(assessment.calculatedAt)}
          </span>
        )}
        {entry.changed ? (
          <span className="text-[11px] font-medium text-amber-800">
            changed since its previous assessment
          </span>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Data coverage — which facts are strong, which are weak
// ---------------------------------------------------------------------------

function CoverageSection({ data }: { data: DashboardData }) {
  const section = data.coverage;
  return (
    <SectionShell
      id="dashboard-coverage"
      title="Data coverage"
      status={section.status}
      note={section.note}
    >
      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <h3 className="text-[12px] font-medium">Economics completeness</h3>
          <Distribution tally={section.economicsCompleteness} />
        </div>
        <div>
          <h3 className="text-[12px] font-medium">Evidence confidence</h3>
          <Distribution tally={section.evidenceConfidence} />
        </div>
        <div>
          <h3 className="text-[12px] font-medium">Match confidence</h3>
          <Distribution tally={section.matchConfidence} />
        </div>
        <div>
          <h3 className="text-[12px] font-medium">Supplier evidence</h3>
          <ul className="mt-3 flex flex-col gap-1.5 text-[12px]">
            <CoverageRow
              label="Confirmed"
              count={section.supplierEvidence.confirmed}
              total={supplierTotal(section)}
              meaning="A candidate is in scope and a supplier observation is stored"
            />
            <CoverageRow
              label="Unknown"
              count={section.supplierEvidence.unknown}
              total={supplierTotal(section)}
              meaning="A candidate is in scope but no supplier observation is stored"
            />
            <CoverageRow
              label="None"
              count={section.supplierEvidence.none}
              total={supplierTotal(section)}
              meaning="No supplier candidate — the marketplace-only scope"
            />
          </ul>
        </div>
      </div>
    </SectionShell>
  );
}

function supplierTotal(section: DashboardData["coverage"]): number {
  const { confirmed, unknown, none } = section.supplierEvidence;
  return confirmed + unknown + none;
}

function CoverageRow({
  label,
  count,
  total,
  meaning,
}: {
  label: string;
  count: number;
  total: number;
  meaning: string;
}) {
  const share = total === 0 ? 0 : Math.round((count / total) * 100);
  return (
    <li className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <span className="w-20 shrink-0 text-right tabular-nums">
        {count} ({share}%)
      </span>
      <span className="text-muted">{meaning}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Recent activity — derived from persisted timestamps, no event table
// ---------------------------------------------------------------------------

function ActivitySection({ data }: { data: DashboardData }) {
  const section = data.activity;
  return (
    <SectionShell
      id="dashboard-activity"
      title="Recent activity"
      status={section.status}
      note={section.note}
    >
      {section.events.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          No timestamped record falls inside the activity window. This feed is
          derived from the timestamps the persisted layers already carry — no event
          table exists or was created for it.
        </p>
      ) : (
        <ol className="mt-4 flex flex-col gap-2 border-l border-border pl-4">
          {section.events.map((event) => (
            <ActivityEventRow
              key={`${event.type}-${event.at}-${event.detail}`}
              event={event}
            />
          ))}
        </ol>
      )}
      <p className="mt-3 text-[11px] text-muted">
        Bounded to {section.limit} events.
      </p>
      {section.unavailableSources.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5 text-[11px] text-amber-800">
          {section.unavailableSources.map((source) => (
            <li key={source}>
              Source {source} read nothing, so this feed is shorter than a complete
              one — not silently incomplete.
            </li>
          ))}
        </ul>
      ) : null}
    </SectionShell>
  );
}

function ActivityEventRow({ event }: { event: ActivityEvent }) {
  return (
    <li className="flex flex-col gap-0.5 text-[12px]">
      <span className="font-medium text-foreground">{event.label}</span>
      <span className="text-muted">
        {event.detail} · {observedAt(event.at)}
      </span>
      {event.detailHref ? (
        <Link
          href={event.detailHref}
          className="w-fit text-[11px] text-foreground underline underline-offset-2"
        >
          Open the opportunity
        </Link>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Freshness — ages, never verdicts
// ---------------------------------------------------------------------------

function FreshnessSection({ data }: { data: DashboardData }) {
  const section = data.freshness;
  return (
    <SectionShell
      id="dashboard-freshness"
      title="Freshness"
      status={section.status}
      note={section.note}
    >
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-[12px]">
          <caption className="sr-only">
            The newest timestamp each source was read, with its age against the
            project&#39;s published staleness threshold of{" "}
            {section.staleThresholdHours} hours.
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">
                Source
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Last observed
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Age
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Staleness
              </th>
            </tr>
          </thead>
          <tbody>
            {section.entries.map((entry) => (
              <FreshnessRow
                key={entry.label}
                entry={entry}
                thresholdHours={section.staleThresholdHours}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-muted">
        Freshness reports age against the project&#39;s single published threshold (
        {section.staleThresholdHours} h). It never asserts a listing&#39;s present
        state, and no freshness window is invented here.
      </p>
    </SectionShell>
  );
}

function FreshnessRow({
  entry,
  thresholdHours,
}: {
  entry: FreshnessEntry;
  thresholdHours: number;
}) {
  return (
    <tr className="border-b border-border">
      <td className="py-2 pr-3">{entry.label}</td>
      <td className="py-2 pr-3 tabular-nums">{observedAt(entry.observedAt)}</td>
      <td className="py-2 pr-3 tabular-nums">{ageLabel(entry.ageHours)}</td>
      <td className="py-2 pr-3">
        {entry.observedAt === null ? (
          <span className="text-muted">never observed</span>
        ) : entry.stale ? (
          <span className="font-medium text-amber-800">
            older than {thresholdHours} h
          </span>
        ) : (
          <span>within {thresholdHours} h</span>
        )}
      </td>
    </tr>
  );
}

