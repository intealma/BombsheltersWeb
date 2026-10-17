import { useState } from 'preact/hooks';
import { isConfigured, isDemo, supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { DEMO_ROLES, demoLogin, DemoLoginError, rememberedDemoCode, type DemoRole } from '../lib/session';

function DemoSwitcher() {
  useLang();
  const [code, setCode] = useState(rememberedDemoCode());
  const [busy, setBusy] = useState<DemoRole | null>(null);
  const [error, setError] = useState('');

  async function enter(role: DemoRole) {
    if (code.trim().length < 4) return setError(t('demo.codeMissing'));
    setBusy(role);
    setError('');
    try {
      await demoLogin(role, code.trim());
    } catch (e) {
      const status = e instanceof DemoLoginError ? e.status : 0;
      setError(status === 401 ? t('demo.wrongCode') : status === 429 ? t('demo.tooMany') : t('demo.failed'));
      if (status === 401) setCode('');
      setBusy(null);
    }
  }

  return (
    <section class="card narrow demo-login">
      <div class="eyebrow">{t('app.demo')}</div>
      <h1>{t('demo.title')}</h1>
      <p class="muted">{t('demo.intro')}</p>
      <label class="field">
        <span>{t('demo.code')}</span>
        <input type="password" autocomplete="off" maxLength={200} value={code} onInput={(e) => setCode(e.currentTarget.value)} />
      </label>
      <div class="role-grid">
        {DEMO_ROLES.map((role) => (
          <button key={role} type="button" class="role-btn" disabled={busy !== null} onClick={() => enter(role)}>
            <span class="role-name">{t(`demo.role.${role}.name`)}</span>
            <span class="role-desc">{busy === role ? t('login.submitting') : t(`demo.role.${role}.desc`)}</span>
          </button>
        ))}
      </div>
      {error && <p class="error" role="alert">{error}</p>}
      <p class="muted small">{t('demo.fiction')}</p>
    </section>
  );
}

function EmailLogin() {
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
    <form onSubmit={submit} class="form">
      <label>
        <span>{t('login.email')}</span>
        <input type="email" autocomplete="username" required maxLength={254} value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
      </label>
      <label>
        <span>{t('login.password')}</span>
        <input type="password" autocomplete="current-password" required maxLength={128} value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
      </label>
      {error && <p class="error" role="alert">{t('login.failed')}</p>}
      <button type="submit" class="primary" disabled={busy || !isConfigured}>
        {busy ? t('login.submitting') : t('login.submit')}
      </button>
    </form>
  );
}

export function Login() {
  useLang();
  if (!isConfigured) {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{t('login.notConfigured')}</p>
      </section>
    );
  }
  if (isDemo) {
    return (
      <div class="stack">
        <DemoSwitcher />
        <details class="card narrow email-login">
          <summary>{t('demo.emailLogin')}</summary>
          <EmailLogin />
        </details>
      </div>
    );
  }
  return (
    <section class="card narrow">
      <h1>{t('login.title')}</h1>
      <p class="muted">{t('app.tagline')}</p>
      <EmailLogin />
    </section>
  );
}
