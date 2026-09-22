import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only persistence client for the product-intelligence tables.
 *
 * This is the ONLY code path that writes to or reads from the V1 intelligence
 * schema, and it always uses the **service-role** key:
 *
 *   - The service role bypasses Row Level Security, which is required because
 *     these tables intentionally carry *no* anon/authenticated policies
 *     (docs/DATABASE.md §11). They are internal server-owned data.
 *   - The key is read from a non-prefixed environment variable inside a
 *     `server-only` module, so any attempt to bundle this into client
 *     JavaScript fails at build time. It can never reach the browser.
 *
 * Returns `null` when the required environment variables are not configured, so
 * callers can degrade safely (best-effort persistence) instead of crashing.
 */
export function createPersistenceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Human-readable reason strings for the persistence-disabled state. Kept here
 * so routes report a consistent, secret-free explanation.
 */
export const PERSISTENCE_DISABLED_REASON =
  "Persistence is not configured on this server, so this observation was not stored. Set the Supabase environment variables to record history.";
