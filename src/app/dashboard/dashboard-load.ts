"use client";

/**
 * The Dashboard panel's request contract — the pure, render-free half of the
 * loading state machine (docs/ARCHITECTURE.md §19.6).
 *
 * Extracted from `dashboard-panel.tsx` for the same reason the boundary's query
 * parsing lives in `dashboard-http.ts`: the panel is a large React component and
 * this logic is the part that must never leave the page loading forever, so it
 * belongs in a module Node's own runner can exercise directly.
 *
 * Every outcome is terminal. `loading` is a state only the panel holds before
 * this resolves; whatever the server does — a usable model, a not-configured
 * answer, an error, a body that is not what the contract describes, or a request
 * that never answers at all — this returns one of three finished states, so the
 * panel always renders something the reader can see and act on.
 */

import { DASHBOARD_FETCH_TIMEOUT_MS } from "@/lib/dashboard/limits";
import type { DashboardData } from "@/lib/dashboard/types";
import type {
  DashboardErrorResponse,
  DashboardSuccessResponse,
} from "@/types/dashboard";

export const DASHBOARD_LOADING_MESSAGE =
  "Reading the persisted intelligence for this Dashboard…";
export const DASHBOARD_NOT_CONFIGURED_MESSAGE =
  "The Dashboard could not be loaded. Persistence is not configured on this server.";
const FALLBACK_ERROR = "The Dashboard could not be loaded.";
const NETWORK_ERROR = "The Dashboard request did not complete.";

export type DashboardLoadOutcome =
  | { status: "ready"; data: DashboardData }
  | { status: "not-configured" }
  | { status: "error"; errorMessage: string };

/**
 * Issues one Dashboard request and maps the result to a terminal outcome.
 *
 * `signal` is optional: without one the request is bounded by
 * `DASHBOARD_FETCH_TIMEOUT_MS`, which is longer than the server's own worst case
 * so a merely-slow persistence layer still answers with its honest degradation. A
 * caller may pass its own signal to abort sooner. Either way, a request that
 * never answers becomes an error rather than an unending reading state.
 */
export async function requestDashboard(
  endpoint: string,
  signal?: AbortSignal,
): Promise<DashboardLoadOutcome> {
  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(DASHBOARD_FETCH_TIMEOUT_MS),
    });

    if (response.status === 503) {
      return { status: "not-configured" };
    }

    if (!response.ok) {
      const errorBody = (await response
        .json()
        .catch(() => null)) as DashboardErrorResponse | null;
      return {
        status: "error",
        errorMessage: errorBody?.error ?? FALLBACK_ERROR,
      };
    }

    const body = (await response.json().catch(() => null)) as DashboardSuccessResponse | null;
    // A `200` that is not the contract's shape is a malformed response, and a
    // malformed response must not reach the panel as "ready with no data" — that
    // is the one path that could leave the reading state up forever.
    if (
      body === null ||
      (body.status !== "ok" && body.status !== "degraded") ||
      body.dashboard === null ||
      typeof body.dashboard !== "object"
    ) {
      return { status: "error", errorMessage: FALLBACK_ERROR };
    }

    return { status: "ready", data: body.dashboard };
  } catch {
    return { status: "error", errorMessage: NETWORK_ERROR };
  }
}
