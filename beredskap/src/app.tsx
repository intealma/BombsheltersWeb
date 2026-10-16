import { useEffect, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { isDemo, supabase } from './lib/supabase';
import { setLang, t, useLang } from './i18n';
import { Login } from './views/login';
import { Home } from './views/home';
import { ShelterMark } from './components/shelter-mark';

export function App() {
  const lang = useLang();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <ShelterMark class="brand-mark" />
          <div class="brand-text">
            {t('app.name')}
            <small>skyddsrum.se</small>
          </div>
        </div>
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

      <main class="content">
        {session === undefined ? (
          <p class="muted">{t('home.loading')}</p>
        ) : session ? (
          <Home session={session} />
        ) : (
          <Login />
        )}
      </main>
    </div>
  );
}
