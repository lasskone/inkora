import "server-only";

import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { DatabaseHealthResponse } from "@/types/database-health";

// Health must always reflect the live process, never a cached response.
export const dynamic = "force-dynamic";

// Never keep a request (or a downstream client) waiting on a health probe.
const PROBE_TIMEOUT_MS = 5000;

/**
 * Server-side database connectivity probe.
 *
 * Uses the privileged (service-role) Supabase client to perform a benign,
 * read-only round-trip against the live project: listing one auth user. That
 * call only succeeds when the Inkora server can actually reach the configured
 * Supabase backend, and it requires no business table to exist.
 *
 * The response is deliberately coarse. It never returns the underlying error,
 * hostnames, ports, connection strings, SQL, credentials, or stack traces —
 * only a coarse reachability verdict. Diagnostics logged server-side are kept
 * equally safe.
 */
export async function GET(): Promise<NextResponse<DatabaseHealthResponse>> {
  const timestamp = new Date().toISOString();

  const unreachable: DatabaseHealthResponse = {
    status: "error",
    service: "inkora-db",
    database: "unreachable",
    timestamp,
  };

  const supabase = createSupabaseServerClient();
  if (supabase === null) {
    // Missing server-side configuration. Logged without values.
    console.warn("[health/db] Supabase server client is not configured.");
    return NextResponse.json(unreachable, { status: 503 });
  }

  try {
    const probe = await withTimeout(
      supabase.auth.admin.listUsers({ page: 1, perPage: 1 }),
      PROBE_TIMEOUT_MS,
    );

    if (probe.error) {
      // A real round-trip happened but the backend rejected it: unreachable.
      console.warn("[health/db] Supabase probe reported a failure.");
      return NextResponse.json(unreachable, { status: 503 });
    }

    return NextResponse.json(
      {
        status: "ok",
        service: "inkora-db",
        database: "reachable",
        timestamp,
      },
      { status: 200 },
    );
  } catch {
    // Timeouts, network failures, thrown clients — all collapse to the same
    // coarse verdict. No details are forwarded to the caller.
    console.warn("[health/db] Supabase probe threw or timed out.");
    return NextResponse.json(unreachable, { status: 503 });
  }
}

/**
 * Rejects a promise if it does not settle within `ms`, so a hung remote can
 * never stall a health check.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("probe timeout")), ms),
  );
  return Promise.race([promise, timeout]) as Promise<T>;
}
