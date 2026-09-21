import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser-safe Supabase client.
 *
 * Reads only `NEXT_PUBLIC_*` variables: the project URL and the anon key. The
 * anon key is designed to be public and is protected by Row Level Security.
 *
 * The service-role key is never read here, and this module must never be
 * replaced by the server client. Returns `null` when the public variables are
 * not configured, so the application degrades safely instead of crashing.
 */
export function createSupabaseBrowserClient(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey);
}
