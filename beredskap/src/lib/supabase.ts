import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

// The anon key is public by design: what a signed-in user may read or write
// is decided by row-level security in the database, not by this client.
export const supabase = createClient(url || 'http://127.0.0.1:54321', anonKey || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'beredskap-auth' },
});

export const isDemo = import.meta.env.VITE_DEMO_MODE === 'true';
