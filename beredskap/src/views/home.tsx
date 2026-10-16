import { useEffect, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, tn, useLang } from '../i18n';
import { deleteAllDrafts, listDrafts } from '../lib/drafts';
import { formatDate, formatNumber } from '../lib/format';
import { href } from '../lib/router';
import { ShelterMark } from '../components/shelter-mark';

// Owners get their whole list; länsstyrelser and kommuner get their own
// views in later milestones, so they only see a sample here for now.
const OWNER_LIMIT = 1000;
const AREA_LIMIT = 50;

type OrgKind = 'owner' | 'lansstyrelse' | 'kommun';

interface Organisation {
  id: string;
  kind: OrgKind;
  name: string;
  lan_kod: string | null;
  kommun_kod: string | null;
}

interface Shelter {
  id: string;
  address: string;
  capacity: number;
  kommuner: { namn: string } | null;
}

interface LatestCheck {
  id: string;
  submitted_at: string;
  brist_count: number;
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'no-membership' }
  | {
      status: 'ready';
      org: Organisation;
      role: string;
      scopeName: string;
      shelters: Shelter[];
      count: number;
      latest: Record<string, LatestCheck>;
      drafts: Set<string>;
    };

const MODULES: Record<OrgKind, string[]> = {
  owner: ['maintenance', 'plan'],
  lansstyrelse: ['orders', 'overview'],
  kommun: ['overview'],
};

async function loadHome(userId: string): Promise<State> {
  // Every query below is filtered by row-level security in the database; the
  // client only asks, it never decides what the user may see.
  const memberships = await supabase
    .from('memberships')
    .select('role, organisations(id, kind, name, lan_kod, kommun_kod)')
    .eq('user_id', userId)
    .limit(1);
  if (memberships.error) return { status: 'error' };
  // PostgREST returns a single object for this many-to-one embed.
  const membership = memberships.data?.[0] as unknown as { role: string; organisations: Organisation | null } | undefined;
  if (!membership?.organisations) return { status: 'no-membership' };
  const org = membership.organisations;
  const isOwner = org.kind === 'owner';

  let scopeName = '';
  if (org.kind === 'lansstyrelse' && org.lan_kod) {
    scopeName = (await supabase.from('lan').select('namn').eq('kod', org.lan_kod).single()).data?.namn ?? org.lan_kod;
  } else if (org.kind === 'kommun' && org.kommun_kod) {
    scopeName = (await supabase.from('kommuner').select('namn').eq('kod', org.kommun_kod).single()).data?.namn ?? org.kommun_kod;
  }

  const [shelters, checks, drafts] = await Promise.all([
    supabase
      .from('shelters')
      .select('id, address, capacity, kommuner(namn)', { count: 'exact' })
      .order('kommun_kod')
      .order('address')
      .limit(isOwner ? OWNER_LIMIT : AREA_LIMIT),
    isOwner
      ? supabase.from('self_checks').select('id, shelter_id, submitted_at, brist_count').order('submitted_at', { ascending: false }).limit(1000)
      : Promise.resolve({ data: [] as (LatestCheck & { shelter_id: string })[] }),
    isOwner ? listDrafts(userId).catch(() => []) : Promise.resolve([]),
  ]);
  if (shelters.error) return { status: 'error' };

  const latest: Record<string, LatestCheck> = {};
  for (const c of (checks.data ?? []) as (LatestCheck & { shelter_id: string })[]) latest[c.shelter_id] ??= c;

  return {
    status: 'ready',
    org,
    role: membership.role,
    scopeName,
    shelters: (shelters.data ?? []) as unknown as Shelter[],
    count: shelters.count ?? 0,
    latest,
    drafts: new Set(drafts.map((d) => d.shelterId)),
  };
}

export function Home({ session }: { session: Session }) {
  useLang();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadHome(session.user.id).then((s) => !cancelled && setState(s));
    return () => {
      cancelled = true;
    };
  }, [session.user.id]);

  // Unsent drafts may hold deficiencies and photos. On a shared device they
  // must not outlive the session, so signing out deletes them (after asking).
  async function signOut() {
    const drafts = await listDrafts(session.user.id).catch(() => []);
    if (drafts.length && !window.confirm(t('home.signOutDrafts', { count: drafts.length }))) return;
    await deleteAllDrafts(session.user.id).catch(() => undefined);
    await supabase.auth.signOut();
  }

  if (state.status === 'loading') return <p class="muted">{t('home.loading')}</p>;
  if (state.status !== 'ready') {
    return (
      <section class="card narrow">
        <p class={state.status === 'error' ? 'error' : ''}>
          {t(state.status === 'error' ? 'home.loadFailed' : 'home.noMembership')}
        </p>
        <button type="button" class="secondary" onClick={signOut}>{t('home.signOut')}</button>
      </section>
    );
  }

  const { org, role, scopeName, shelters, count, latest, drafts } = state;
  const isOwner = org.kind === 'owner';
  const title =
    org.kind === 'lansstyrelse' ? t('home.sheltersLst', { lan: scopeName })
    : org.kind === 'kommun' ? t('home.sheltersKommun', { kommun: scopeName })
    : t('home.sheltersOwner');

  return (
    <div class="stack">
      <section class="card org-card">
        <div>
          <div class="eyebrow">{t(`roles.${role}`)}</div>
          <h1>{org.name}</h1>
          <p class="muted small">{session.user.email}</p>
        </div>
        <button type="button" class="secondary" onClick={signOut}>{t('home.signOut')}</button>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>{title}</h2>
          <span class="stat">{t('home.count', { count: formatNumber(count) })}</span>
        </div>
        {count === 0 ? (
          <p class="muted">{t('home.empty')}</p>
        ) : (
          <>
            <ul class="shelter-list">
              {shelters.map((s) => {
                const last = latest[s.id];
                const main = (
                  <>
                    <ShelterMark class="row-mark" />
                    <div class="row-main">
                      <div class="row-title">{s.address || s.id}</div>
                      <div class="row-sub">
                        {s.id} · {s.kommuner?.namn} · {t('home.capacity', { capacity: s.capacity })}
                      </div>
                    </div>
                  </>
                );
                if (!isOwner) return <li key={s.id}><div class="row">{main}</div></li>;
                return (
                  <li key={s.id}>
                    <a class="row" href={href('skyddsrum', s.id, 'kontroll')}>
                      {main}
                      <span class={`chip${drafts.has(s.id) ? ' chip-strong' : ''}`}>
                        {drafts.has(s.id) ? t('home.draft') : t('home.startCheck')} →
                      </span>
                    </a>
                    <div class="row-meta">
                      {last ? (
                        <a href={href('kontroll', last.id)}>
                          {last.brist_count
                            ? t('home.lastCheckBrister', { date: formatDate(last.submitted_at), brister: tn('check.countBrist', last.brist_count) })
                            : t('home.lastCheck', { date: formatDate(last.submitted_at) })}
                          {' · '}
                          {t('home.receiptLink')}
                        </a>
                      ) : (
                        <span class="muted">{t('home.neverChecked')}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {count > shelters.length && (
              <p class="muted small">{t('home.showingFirst', { shown: shelters.length, count: formatNumber(count) })}</p>
            )}
          </>
        )}
      </section>

      <section class="card">
        <h2>{t('home.comingSoon')}</h2>
        <ul class="module-list">
          {MODULES[org.kind].map((m) => (
            <li key={m}>{t(`home.modules.${m}`)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
