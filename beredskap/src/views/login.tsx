import { useState } from 'preact/hooks';
import { isConfigured, isDemo, supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';

export function Login() {
  useLang();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(false);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    // One generic message, so the form does not reveal which accounts exist.
    if (error) setError(true);
  }

  return (
    <section class="card narrow">
      <h1>{t('login.title')}</h1>
      <p class="muted">{t('app.tagline')}</p>
      {isDemo && <p class="notice">{t('app.demoNotice')}</p>}
      {!isConfigured && <p class="error" role="alert">{t('login.notConfigured')}</p>}

      <form onSubmit={submit} class="form">
        <label>
          <span>{t('login.email')}</span>
          <input
            type="email"
            autocomplete="username"
            required
            maxLength={254}
            value={email}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <label>
          <span>{t('login.password')}</span>
          <input
            type="password"
            autocomplete="current-password"
            required
            maxLength={128}
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        {error && <p class="error" role="alert">{t('login.failed')}</p>}
        <button type="submit" class="primary" disabled={busy || !isConfigured}>
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
    </section>
  );
}
