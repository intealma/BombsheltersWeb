import { useEffect, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import type { FunctionComponent } from 'preact';
import { t } from '../i18n';

/**
 * The dashboard pulls in MapLibre (large), so it is loaded only when a
 * länsstyrelse user opens it. Owners on phones never download it.
 */
export function LazyDashboard({ session }: { session: Session }) {
  const [View, setView] = useState<FunctionComponent<{ session: Session }> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    import('./lst-dashboard')
      .then((m) => setView(() => m.LstDashboard))
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <p class="error" role="alert">{t('home.loadFailed')}</p>;
  return View ? <View session={session} /> : <p class="muted">{t('home.loading')}</p>;
}
