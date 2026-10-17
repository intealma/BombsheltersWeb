import { useEffect, useState } from 'preact/hooks';
import { t, useLang } from '../i18n';
import { fetchActiveActivation, formatCountdown, type Activation } from '../lib/readiness';
import { href } from '../lib/router';
import { useNow } from './countdown';

/** Fired when a simulation is started or ended, so the banner updates at once. */
export const READINESS_CHANGED = 'readiness-changed';

/**
 * Shown on every screen while the owner organisation runs a simulation, so
 * nobody mistakes the exercise for a real alert (or forgets it is running).
 * RLS returns nothing for users outside the owner organisation.
 */
export function SimulationBanner({ userId }: { userId: string }) {
  useLang();
  const [activation, setActivation] = useState<Activation | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    let stopped = false;
    const check = () => fetchActiveActivation().then((a) => !stopped && setActivation(a)).catch(() => undefined);
    check();
    const id = setInterval(check, 30_000);
    window.addEventListener('hashchange', check);
    window.addEventListener(READINESS_CHANGED, check);
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener('hashchange', check);
      window.removeEventListener(READINESS_CHANGED, check);
    };
  }, [userId]);

  if (!activation) return null;
  const left = new Date(activation.deadline_at).getTime() - now;
  return (
    <div class="sim-banner-wrap" role="status">
      <a class="sim-banner" href={href('beredskap')}>
        <span class="sim-badge">{t('readiness.simulation.badge')}</span>
        <span>
          {left > 0
            ? t('readiness.simulation.banner', { time: formatCountdown(left) })
            : t('readiness.simulation.bannerOver')}
        </span>
      </a>
    </div>
  );
}
