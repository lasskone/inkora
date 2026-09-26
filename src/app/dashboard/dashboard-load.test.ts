/**
 * Dashboard panel load tests — the terminal-state contract
 * (docs/ARCHITECTURE.md §19.6, §19.7).
 *
 * `requestDashboard` is the pure, render-free half of the panel's loading state
 * machine, so these pin the one guarantee the production freeze violated:
 * whatever the server does, the outcome is terminal, and the panel can never be
 * left on its reading message. Every case is driven by an injected `fetch`, so
 * no network and no credentials are involved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { requestDashboard } from "./dashboard-load";
import {
  applyDashboardOutcome,
  beginDashboardLoad,
  type DashboardLoadOutcome,
  type DashboardLoadState,
} from "./dashboard-load";
import type { DashboardData } from "@/lib/dashboard/types";

const ENDPOINT = "/api/dashboard";

const DASHBOARD = { hasIntelligence: false, warnings: [] as string[] };

const VALID_BODY = {
  status: "ok" as const,
  dashboard: DASHBOARD,
  bounds: { limit: 12 },
  timestamp: "2026-09-23T12:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Installs a `fetch` and records the init each call received. */
function installFetch(respond: (init?: RequestInit) => Response | Promise<Response>): {
  calls: RequestInit[];
  restore(): void;
} {
  const calls: RequestInit[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    return await respond(init);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A request that never settles on its own — only its abort signal can end it. */
function hangingFetch(): typeof globalThis.fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        return; // genuinely unbounded: only reachable when the caller passes none
      }
      if (signal.aborted) {
        reject(new Error("The user aborted a request."));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("The user aborted a request.")),
        { once: true },
      );
    });
  }) as typeof globalThis.fetch;
}


// ---------------------------------------------------------------------------
// A usable answer terminates the load
// ---------------------------------------------------------------------------

test("a successful response terminates loading and hands the model to the panel", async () => {
  const fetch = installFetch(() => jsonResponse(VALID_BODY));
  try {
    const outcome = await requestDashboard(ENDPOINT);
    assert.equal(outcome.status, "ready");
    assert.deepEqual((outcome as { data: unknown }).data, DASHBOARD);
  } finally {
    fetch.restore();
  }
});

test("a degraded response is still a success the panel can render", async () => {
  const fetch = installFetch(() =>
    jsonResponse({ ...VALID_BODY, status: "degraded" as const }),
  );
  try {
    const outcome = await requestDashboard(ENDPOINT);
    assert.equal(outcome.status, "ready");
  } finally {
    fetch.restore();
  }
});

test("the request is always bounded by an abort signal", async () => {
  const fetch = installFetch(() => jsonResponse(VALID_BODY));
  try {
    await requestDashboard(ENDPOINT);
  } finally {
    fetch.restore();
  }
  assert.equal(fetch.calls.length, 1);
  assert.ok(fetch.calls[0]?.signal instanceof AbortSignal);
});

// ---------------------------------------------------------------------------
// Every failure is terminal and surfaces itself
// ---------------------------------------------------------------------------

test("a not-configured response terminates loading as the not-configured state", async () => {
  const fetch = installFetch(() =>
    jsonResponse(
      { status: "error", error: "not configured", code: "DASHBOARD_NOT_CONFIGURED" },
      503,
    ),
  );
  try {
    const outcome = await requestDashboard(ENDPOINT);
    assert.equal(outcome.status, "not-configured");
  } finally {
    fetch.restore();
  }
});

test("an error response terminates loading and exposes the server's message", async () => {
  const fetch = installFetch(() =>
    jsonResponse(
      {
        status: "error",
        error: 'The "band" filter does not accept "NOPE".',
        code: "INVALID_FILTER",
      },
      400,
    ),
  );
  try {
    const outcome = await requestDashboard(ENDPOINT);
    assert.equal(outcome.status, "error");
    assert.equal(
      (outcome as { errorMessage: string }).errorMessage,
      'The "band" filter does not accept "NOPE".',
    );
  } finally {
    fetch.restore();
  }
});

test("an error response with an unusable body still terminates with a message", async () => {
  const fetch = installFetch(() => jsonResponse("<html>502 Bad Gateway</html>", 502));
  try {
    const outcome = await requestDashboard(ENDPOINT);
    assert.equal(outcome.status, "error");
    assert.equal(
      (outcome as { errorMessage: string }).errorMessage,
      "The Dashboard could not be loaded.",
    );
  } finally {
    fetch.restore();
  }
});

test("a malformed success body terminates as an error rather than loading forever", async () => {
  // A `200` without the contract's dashboard object used to reach the panel as
  // "ready with no data" — the one path that left the reading message up forever.
  const fetch = installFetch(() => jsonResponse({ status: "ok", bounds: {}, timestamp: "t" }));
  try {
    const outcome = await requestDashboard(ENDPOINT);
    assert.equal(outcome.status, "error");
    assert.equal(
      (outcome as { errorMessage: string }).errorMessage,
      "The Dashboard could not be loaded.",
    );
  } finally {
    fetch.restore();
  }
});

test("a malformed dashboard payload is rejected too", async () => {
  const fetch = installFetch(() =>
    jsonResponse({ status: "ok", dashboard: null, bounds: {}, timestamp: "t" }),
  );
  try {
    const outcome = await requestDashboard(ENDPOINT);
    assert.equal(outcome.status, "error");
  } finally {
    fetch.restore();
  }
});

test("a request that never settles terminates when its bound fires", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  const controller = new AbortController();
  try {
    const outcome = requestDashboard(ENDPOINT, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const settled = await Promise.race([
      outcome.then((value) => ({ status: value.status })),
      new Promise<{ status: string }>((resolve) =>
        setTimeout(() => resolve({ status: "never-settled" }), 2_000),
      ),
    ]);
    assert.notEqual(settled.status, "never-settled");
    assert.equal(settled.status, "error");
  } finally {
    globalThis.fetch = original;
  }
});


// ---------------------------------------------------------------------------
// The panel's state machine — no path may keep status === "loading"
// ---------------------------------------------------------------------------
//
// `applyDashboardOutcome` is the whole render-side transition table, and the
// state it returns is what the panel renders. The production freeze was a
// staleness guard that tested `previous.appliedKey` — `undefined` until the
// first response lands — against the request key, so the first terminal outcome
// was always dropped and the panel stayed on its reading message forever. These
// tests pin the load contract from the render side: whatever happens, the state
// leaves loading.

const KEY = "/api/dashboard";

function loadingState(): DashboardLoadState {
  return { status: "loading" };
}

function readyOutcome(): DashboardLoadOutcome {
  return { status: "ready", data: DASHBOARD as DashboardData };
}

/** Applies an outcome the way the panel does for the request it started last. */
function applyAsCurrent(
  previous: DashboardLoadState,
  outcome: DashboardLoadOutcome,
  requestKey = KEY,
): DashboardLoadState {
  return applyDashboardOutcome(previous, outcome, requestKey, true);
}

test("the initial state is loading and carries no applied key", () => {
  assert.equal(loadingState().status, "loading");
  assert.equal(loadingState().appliedKey, undefined);
});

test("a first successful response leaves loading — the regression the production freeze violated", () => {
  // The shipped guard compared `previous.appliedKey` (undefined here) to the
  // request key, so this outcome was discarded and the state stayed loading.
  const next = applyAsCurrent(loadingState(), readyOutcome());
  assert.equal(next.status, "ready");
  assert.deepEqual(next.data, DASHBOARD);
  assert.equal(next.appliedKey, KEY);
});

test("a first not-configured response leaves loading", () => {
  const next = applyAsCurrent(loadingState(), { status: "not-configured" });
  assert.equal(next.status, "not-configured");
  assert.equal(next.appliedKey, KEY);
});

test("a first error response leaves loading and keeps the server's message", () => {
  const next = applyAsCurrent(loadingState(), {
    status: "error",
    errorMessage: "The Dashboard could not be loaded.",
  });
  assert.equal(next.status, "error");
  assert.equal(next.appliedKey, KEY);
});

test("a malformed response reaches the panel as an error, never as a lingering loading state", async () => {
  const fetch = installFetch(() => jsonResponse({ status: "ok", bounds: {}, timestamp: "t" }));
  try {
    const outcome = await requestDashboard(ENDPOINT);
    const next = applyAsCurrent(loadingState(), outcome);
    assert.equal(next.status, "error");
  } finally {
    fetch.restore();
  }
});

test("a rejected fetch reaches the panel as an error, never as a lingering loading state", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network is unreachable");
  }) as typeof globalThis.fetch;
  try {
    const outcome = await requestDashboard(ENDPOINT);
    const next = applyAsCurrent(loadingState(), outcome);
    assert.equal(next.status, "error");
    assert.equal(next.errorMessage, "The Dashboard request did not complete.");
  } finally {
    globalThis.fetch = original;
  }
});

test("an aborted request reaches the panel as an error, never as a lingering loading state", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  const controller = new AbortController();
  try {
    const outcome = requestDashboard(ENDPOINT, controller.signal);
    setTimeout(() => controller.abort(), 25);
    const next = applyAsCurrent(loadingState(), await outcome);
    assert.equal(next.status, "error");
  } finally {
    globalThis.fetch = original;
  }
});

test("a synchronous exception before the fetch completes still terminates as an error", async () => {
  // `AbortSignal.timeout` is constructed inside `requestDashboard`'s try block;
  // if the runtime cannot construct it, the throw is caught rather than escaping
  // into React and leaving the panel on its reading state.
  const originalTimeout = AbortSignal.timeout;
  const originalFetch = globalThis.fetch;
  AbortSignal.timeout = (() => {
    throw new Error("AbortSignal.timeout is not supported here");
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = hangingFetch();
  try {
    const outcome = await requestDashboard(ENDPOINT);
    const next = applyAsCurrent(loadingState(), outcome);
    assert.equal(next.status, "error");
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("an outcome for a request a newer one superseded is dropped, keeping the newer request's state", () => {
  // The panel starts a load for KEY, then the reader changes a filter so a newer
  // load starts for a different key. The older response must not overwrite it.
  const newer = applyAsCurrent(loadingState(), readyOutcome(), "/api/dashboard?band=HIGH");
  const stale = applyDashboardOutcome(
    newer,
    { status: "error", errorMessage: "too late" },
    KEY,
    false,
  );
  assert.equal(stale.status, "ready");
  assert.deepEqual(stale.data, DASHBOARD);
  assert.equal(stale.appliedKey, "/api/dashboard?band=HIGH");
});

test("beginDashboardLoad keeps an already-rendered model on screen during a re-read", () => {
  const ready = applyAsCurrent(loadingState(), readyOutcome());
  const restarted = beginDashboardLoad(ready);
  assert.equal(restarted.status, "ready");
  assert.deepEqual(restarted.data, DASHBOARD);
});

test("beginDashboardLoad returns to reading when there is no model to keep on screen", () => {
  const errorState = applyAsCurrent(loadingState(), {
    status: "error",
    errorMessage: "down",
  });
  assert.equal(beginDashboardLoad(errorState).status, "loading");
  assert.equal(beginDashboardLoad(loadingState()).status, "loading");
});
