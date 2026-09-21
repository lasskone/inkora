import { NextResponse } from "next/server";
import type { HealthResponse } from "@/types/health";

// Health must always reflect the live process, never a cached response.
export const dynamic = "force-dynamic";

/**
 * Benign health-check endpoint.
 *
 * Deliberately returns only non-sensitive information. It must never expose
 * secrets, credentials, internal stack traces, or infrastructure details.
 */
export function GET() {
  const body: HealthResponse = {
    status: "ok",
    service: "inkora",
    environment: process.env.NODE_ENV ?? "unknown",
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body);
}
