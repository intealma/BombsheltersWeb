import { useEffect, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { ShelterMark } from '../components/shelter-mark';

const LIST_LIMIT = 50;

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

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'no-membership' }
  | { status: 'ready'; org: Organisation; role: string; scopeName: string; shelters: Shelter[]; count: number };

const MODULES: Record<OrgKind, string[]> = {
  owner: ['selfCheck', 'maintenance', 'plan'],
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

  let scopeName = '';
  if (org.kind === 'lansstyrelse' && org.lan_kod) {
    scopeName = (await supabase.from('lan').select('namn').eq('kod', org.lan_kod).single()).data?.namn ?? org.lan_kod;
  } else if (org.kind === 'kommun' && org.kommun_kod) {
    scopeName = (await supabase.from('kommuner').select('namn').eq('kod', org.kommun_kod).single()).data?.namn ?? org.kommun_kod;
  }

  const shelters = await supabase
    .from('shelters')
    .select('id, address, capacity, kommuner(namn)', { count: 'exact' })
    .order('kommun_kod')
    .order('address')
    .limit(LIST_LIMIT);
  if (shelters.error) return { status: 'error' };

  return {
    status: 'ready',
    org,
    role: membership.role,
    scopeName,
    shelters: (shelters.data ?? []) as unknown as Shelter[],
    count: shelters.count ?? 0,
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

  const signOut = () => supabase.auth.signOut();

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

  const { org, role, scopeName, shelters, count } = state;
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
          <span class="stat">{t('home.count', { count: count.toLocaleString('sv-SE') })}</span>
        </div>
        {count === 0 ? (
          <p class="muted">{t('home.empty')}</p>
        ) : (
          <>
            <ul class="shelter-list">
              {shelters.map((s) => (
                <li key={s.id}>
                  <ShelterMark class="row-mark" />
                  <div class="row-main">
                    <div class="row-title">{s.address || s.id}</div>
                    <div class="row-sub">{s.id} · {s.kommuner?.namn}</div>
                  </div>
                  <div class="row-side">{t('home.capacity', { capacity: s.capacity })}</div>
                </li>
              ))}
            </ul>
            {count > shelters.length && (
              <p class="muted small">{t('home.showingFirst', { shown: shelters.length, count: count.toLocaleString('sv-SE') })}</p>
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
