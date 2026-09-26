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
