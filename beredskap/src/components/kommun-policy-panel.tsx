import { useEffect, useState } from 'preact/hooks';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { formatDateTime } from '../lib/format';

type Level = 'coarse' | 'status' | 'details';
const LEVELS: Level[] = ['coarse', 'status', 'details'];

interface KommunOrg {
  id: string;
  name: string;
  kommun_kod: string;
  level: Level;
  updated_at: string | null;
}

/**
 * What each kommun in the län may see. Länsstyrelse admins can change it;
 * inspectors see it read-only. The database enforces who may change it.
 */
export function KommunPolicyPanel({ isAdmin }: { isAdmin: boolean }) {
  useLang();
  const [orgs, setOrgs] = useState<KommunOrg[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function load() {
    const [{ data: kommuner }, { data: policies }] = await Promise.all([
      supabase.from('organisations').select('id, name, kommun_kod').eq('kind', 'kommun').order('name'),
      supabase.from('kommun_policies').select('kommun_org_id, detail_level, updated_at'),
    ]);
    const byOrg = new Map((policies ?? []).map((p) => [p.kommun_org_id, p]));
    setOrgs(
      ((kommuner ?? []) as { id: string; name: string; kommun_kod: string }[]).map((k) => ({
        ...k,
        level: (byOrg.get(k.id)?.detail_level as Level) ?? 'coarse',
        updated_at: byOrg.get(k.id)?.updated_at ?? null,
      })),
    );
  }

  useEffect(() => {
    load().catch(() => setError(t('home.loadFailed')));
  }, []);

  async function change(org: KommunOrg, level: Level) {
    if (level === 'details' && !window.confirm(t('kommunPolicy.confirmDetails', { kommun: org.name }))) return;
    setBusy(org.id);
    setError('');
    const { error: e } = await supabase.rpc('set_kommun_policy', { p_kommun_org_id: org.id, p_level: level });
    if (e) setError(t('kommunPolicy.failed', { message: e.message }));
    await load();
    setBusy(null);
  }

  if (!orgs || orgs.length === 0) return null;

  return (
    <section class="card">
      <h2>{t('kommunPolicy.title')}</h2>
      <p class="muted small">{t('kommunPolicy.intro')}</p>
      <ul class="policy-list">
        {orgs.map((o) => (
          <li key={o.id}>
            <div class="policy-name">
              {o.name}
              {o.updated_at && <span class="muted small"> · {t('kommunPolicy.changed', { date: formatDateTime(o.updated_at) })}</span>}
            </div>
            {isAdmin ? (
              <select value={o.level} disabled={busy === o.id} aria-label={t('kommunPolicy.levelFor', { kommun: o.name })} onChange={(e) => change(o, e.currentTarget.value as Level)}>
                {LEVELS.map((l) => <option key={l} value={l}>{t(`kommunPolicy.level.${l}`)}</option>)}
              </select>
            ) : (
              <span class="chip">{t(`kommunPolicy.level.${o.level}`)}</span>
            )}
          </li>
        ))}
      </ul>
      {!isAdmin && <p class="muted small">{t('kommunPolicy.adminOnly')}</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}
