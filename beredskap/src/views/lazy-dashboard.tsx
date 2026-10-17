import { useEffect, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import type { FunctionComponent } from 'preact';
import { t } from '../i18n';

type View = FunctionComponent<{ session: Session }>;

/**
 * The dashboards pull in MapLibre (large), so they are loaded only when a
 * länsstyrelse or kommun user opens them. Owners on phones never download it.
 */
function lazyView(load: () => Promise<View>) {
  return function Lazy({ session }: { session: Session }) {
    const [ViewComponent, setView] = useState<View | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
      load()
        .then((v) => setView(() => v))
        .catch(() => setFailed(true));
    }, []);

    if (failed) return <p class="error" role="alert">{t('home.loadFailed')}</p>;
    return ViewComponent ? <ViewComponent session={session} /> : <p class="muted">{t('home.loading')}</p>;
  };
}

export const LazyDashboard = lazyView(() => import('./lst-dashboard').then((m) => m.LstDashboard));
export const LazyKommun = lazyView(() => import('./kommun-overview').then((m) => m.KommunOverview));
