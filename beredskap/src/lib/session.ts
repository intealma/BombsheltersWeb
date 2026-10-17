import { supabase } from './supabase';
import { countAllDrafts, deleteAllDrafts } from './drafts';
import { t } from '../i18n';

/**
 * Unsent drafts may hold deficiencies and photos. On a shared device they
 * must not outlive the session, so signing out deletes them (after asking).
 * Returns false if the user cancelled.
 */
export async function signOutWithDrafts(userId: string): Promise<boolean> {
  const drafts = await countAllDrafts(userId).catch(() => 0);
  if (drafts && !window.confirm(t('home.signOutDrafts', { count: drafts }))) return false;
  await deleteAllDrafts(userId).catch(() => undefined);
  await supabase.auth.signOut();
  return true;
}

// ---------------------------------------------------------------- demo login

export type DemoRole = 'owner' | 'caretaker' | 'lansstyrelse' | 'kommun';
export const DEMO_ROLES: DemoRole[] = ['owner', 'caretaker', 'lansstyrelse', 'kommun'];

const CODE_KEY = 'beredskap-demo-code';

/** The access code is kept for this browser tab only, so switching roles needs no retyping. */
export function rememberedDemoCode(): string {
  try {
    return sessionStorage.getItem(CODE_KEY) ?? '';
  } catch {
    return '';
  }
}

export class DemoLoginError extends Error {
  constructor(public status: number) {
    super(`demo login failed (${status})`);
  }
}

/** Exchanges the meeting access code for a session as one of the demo users. */
export async function demoLogin(role: DemoRole, code: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/demo-login`, {
      method: 'POST',
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, code }),
    });
  } catch {
    throw new DemoLoginError(0);
  }
  if (!res.ok) {
    if (res.status === 401) {
      try {
        sessionStorage.removeItem(CODE_KEY);
      } catch {
        // ignore
      }
    }
    throw new DemoLoginError(res.status);
  }
  const { access_token, refresh_token } = await res.json();
  try {
    sessionStorage.setItem(CODE_KEY, code);
  } catch {
    // Not fatal: the code is just asked for again next time.
  }
  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) throw new DemoLoginError(500);
}
