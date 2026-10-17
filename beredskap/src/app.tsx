import { useEffect, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { isDemo, supabase } from './lib/supabase';
import { setLang, t, useLang } from './i18n';
import { Login } from './views/login';
import { Home } from './views/home';
import { SelfCheck } from './views/self-check';
import { Receipt } from './views/receipt';
import { ShelterPage } from './views/shelter';
import { MaintenanceForm } from './views/maintenance-form';
import { ReadinessPage } from './views/readiness';
import { SimulationBanner } from './components/simulation-banner';
import { useRoute } from './lib/router';
import { ShelterMark } from './components/shelter-mark';

export function App() {
  const lang = useLang();
  const route = useRoute();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/">
          <ShelterMark class="brand-mark" />
          <div class="brand-text">
            {t('app.name')}
            <small>skyddsrum.se</small>
          </div>
        </a>
        <div class="topbar-actions">
          {isDemo && (
            <span class="demo-badge" title={t('app.demoNotice')}>
              {t('app.demo')}
            </span>
          )}
          <button type="button" class="link-button" onClick={() => setLang(lang === 'sv' ? 'en' : 'sv')}>
            {t('lang.switch')}
          </button>
        </div>
      </header>

      {session && <SimulationBanner userId={session.user.id} />}

      <main class="content">
        {session === undefined ? (
          <p class="muted">{t('home.loading')}</p>
        ) : !session ? (
          <Login />
        ) : route[0] === 'skyddsrum' && route[1] && route[2] === 'kontroll' ? (
          <SelfCheck key={route[1]} shelterId={route[1]} session={session} />
        ) : route[0] === 'skyddsrum' && route[1] && route[2] === 'underhall' && route[3] === 'ny' ? (
          <MaintenanceForm key={route[1]} shelterId={route[1]} session={session} />
        ) : route[0] === 'skyddsrum' && route[1] && !route[2] ? (
          <ShelterPage key={route[1]} shelterId={route[1]} session={session} />
        ) : route[0] === 'beredskap' ? (
          <ReadinessPage session={session} />
        ) : route[0] === 'kontroll' && route[1] ? (
          <Receipt key={route[1]} checkId={route[1]} />
        ) : (
          <Home session={session} />
        )}
      </main>
    </div>
  );
}
