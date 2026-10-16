import { useEffect, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { checkCounts, formatDate, formatDateTime, formatNumber } from '../lib/format';
import { href } from '../lib/router';
import { signedUrls } from '../lib/photos';
import { getDraftForShelter, getMaintenanceDraft } from '../lib/drafts';
import { categoryLabel, fetchLog, logToCsv, profileNames, voidEntry, type EntryPhoto, type MaintenanceEntry } from '../lib/maintenance';
import { downloadCsv } from '../lib/csv';
import { downloadMaintenancePdf } from '../lib/pdf';
import { PhotoThumb } from '../components/photos';

interface ShelterInfo {
  id: string;
  address: string;
  capacity: number;
  kommun: string;
  ownerName: string;
}

interface CheckSummary {
  id: string;
  submitted_at: string;
  inspector_name: string;
  ok_count: number;
  brist_count: number;
  na_count: number;
}

type State =
  | { status: 'loading' }
  | { status: 'missing' }
  | {
      status: 'ready';
      shelter: ShelterInfo;
      canAct: boolean;
      isOwnerAdmin: boolean;
      checks: CheckSummary[];
      entries: MaintenanceEntry[];
      photos: EntryPhoto[];
      urls: Record<string, string>;
      names: Record<string, string>;
      checkDraft: boolean;
      maintenanceDraft: boolean;
    };

async function load(shelterId: string, userId: string): Promise<State> {
  const [memberships, shelter, checks, log, checkDraft, maintenanceDraft] = await Promise.all([
    supabase.from('memberships').select('role, organisations(kind)').eq('user_id', userId),
    supabase
      .from('shelters')
      .select('id, address, capacity, kommuner(namn), shelter_assignments(organisations(name))')
      .eq('id', shelterId)
      .maybeSingle(),
    supabase
      .from('self_checks')
      .select('id, submitted_at, inspector_name, ok_count, brist_count, na_count')
      .eq('shelter_id', shelterId)
      .order('submitted_at', { ascending: false }),
    fetchLog(shelterId),
    getDraftForShelter(userId, shelterId).catch(() => undefined),
    getMaintenanceDraft(userId, shelterId).catch(() => undefined),
  ]);
  if (!shelter.data) return { status: 'missing' };

  const s = shelter.data as unknown as {
    id: string;
    address: string;
    capacity: number;
    kommuner: { namn: string } | null;
    shelter_assignments: { organisations: { name: string } | null } | { organisations: { name: string } | null }[] | null;
  };
  const assignment = Array.isArray(s.shelter_assignments) ? s.shelter_assignments[0] : s.shelter_assignments;
  const roles = ((memberships.data ?? []) as unknown as { role: string; organisations: { kind: string } | null }[])
    .filter((m) => m.organisations?.kind === 'owner')
    .map((m) => m.role);
  // Owners only ever see shelters assigned to them, so any owner role here
  // means the shelter is theirs. The database checks again on every write.
  const canAct = roles.includes('owner_admin') || roles.includes('caretaker');

  const [urls, names] = await Promise.all([
    signedUrls(log.photos.map((p) => p.storage_path)).catch(() => ({})),
    profileNames(log.entries.map((e) => e.registered_by)),
  ]);

  return {
    status: 'ready',
    shelter: {
      id: s.id,
      address: s.address || s.id,
      capacity: s.capacity,
      kommun: s.kommuner?.namn ?? '',
      ownerName: assignment?.organisations?.name ?? '',
    },
    canAct,
    isOwnerAdmin: roles.includes('owner_admin'),
    checks: (checks.data ?? []) as CheckSummary[],
    entries: log.entries,
    photos: log.photos,
    urls,
    names,
    checkDraft: Boolean(checkDraft),
    maintenanceDraft: Boolean(maintenanceDraft),
  };
}

function VoidForm({ entryId, onDone, onCancel }: { entryId: string; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await voidEntry(entryId, reason);
      onDone();
    } catch (err) {
      setError(t('maintenance.voidFailed', { message: (err as Error).message }));
      setBusy(false);
    }
  }

  return (
    <form class="void-form" onSubmit={submit}>
      <label class="field">
        <span>{t('maintenance.voidReason')}</span>
        <textarea rows={2} maxLength={500} required minLength={3} value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
      </label>
      {error && <p class="error" role="alert">{error}</p>}
      <div class="actions">
        <button type="button" class="secondary" onClick={onCancel} disabled={busy}>{t('maintenance.cancel')}</button>
        <button type="submit" class="primary" disabled={busy || reason.trim().length < 3}>{t('maintenance.voidConfirm')}</button>
      </div>
    </form>
  );
}

export function ShelterPage({ shelterId, session }: { shelterId: string; session: Session }) {
  useLang();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [voiding, setVoiding] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load(shelterId, session.user.id)
      .then((s) => !cancelled && setState(s))
      .catch(() => !cancelled && setState({ status: 'missing' }));
    return () => {
      cancelled = true;
    };
  }, [shelterId, session.user.id, reloadKey]);

  if (state.status === 'loading') return <p class="muted">{t('home.loading')}</p>;
  if (state.status === 'missing') {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{t('shelter.notFound')}</p>
        <a class="button secondary" href={href()}>{t('receipt.back')}</a>
      </section>
    );
  }

  const { shelter, canAct, isOwnerAdmin, checks, entries, photos, urls, names } = state;
  const photosFor = (entryId: string) => photos.filter((p) => p.context_id === entryId);

  async function exportPdf() {
    setExporting('busy');
    try {
      const fresh = await signedUrls(photos.map((p) => p.storage_path), 120);
      const ascending = [...entries].reverse();
      await downloadMaintenancePdf({
        shelterId: shelter.id,
        shelterAddress: shelter.address,
        kommun: shelter.kommun,
        ownerName: shelter.ownerName,
        entries: ascending.map((e) => ({
          id: e.id,
          performedOn: e.performed_on,
          createdAt: e.created_at,
          category: categoryLabel(e.category),
          description: e.description,
          performedBy: e.performed_by,
          registeredBy: names[e.registered_by] ?? '',
          voided: e.maintenance_voids ? { reason: e.maintenance_voids.reason, at: e.maintenance_voids.voided_at } : null,
          photoUrls: photosFor(e.id).map((p) => fresh[p.storage_path]).filter(Boolean),
        })),
      });
      setExporting('idle');
    } catch {
      setExporting('failed');
    }
  }

  function exportCsv() {
    const counts: Record<string, number> = {};
    for (const p of photos) counts[p.context_id] = (counts[p.context_id] ?? 0) + 1;
    const withShelter = entries.map((e) => ({ ...e, shelters: { address: shelter.address, kommuner: { namn: shelter.kommun } } }));
    downloadCsv(logToCsv(withShelter, counts, names), `underhallslogg-${shelter.id}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return (
    <div class="stack">
      <a class="link-button back-link" href={href()}>← {t('receipt.back')}</a>

      <section class="card">
        <div class="eyebrow">{t('shelter.eyebrow')}</div>
        <h1>{shelter.address}</h1>
        <p class="muted small">
          {shelter.id} · {shelter.kommun} · {t('home.capacity', { capacity: formatNumber(shelter.capacity) })}
          {shelter.ownerName && <> · {shelter.ownerName}</>}
        </p>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>{t('check.eyebrow')}</h2>
        </div>
        {canAct && (
          <a class={`button ${state.checkDraft ? 'primary-link' : 'secondary'} block`} href={href('skyddsrum', shelter.id, 'kontroll')}>
            {state.checkDraft ? t('shelter.continueCheck') : t('shelter.startCheck')}
          </a>
        )}
        {checks.length === 0 ? (
          <p class="muted">{t('shelter.noChecks')}</p>
        ) : (
          <ul class="history-list">
            {checks.map((c) => (
              <li key={c.id}>
                <a href={href('kontroll', c.id)}>
                  <span class="history-date">{formatDateTime(c.submitted_at)}</span>
                  <span class="history-sub">
                    {checkCounts(c.ok_count, c.brist_count, c.na_count)} · {c.inspector_name}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="card">
        <div class="card-head">
          <h2>{t('maintenance.title')}</h2>
        </div>
        <p class="muted small">{t('maintenance.intro')}</p>
        <div class="actions wrap">
          {canAct && (
            <a class={`button ${state.maintenanceDraft ? 'primary-link' : 'secondary'}`} href={href('skyddsrum', shelter.id, 'underhall', 'ny')}>
              {state.maintenanceDraft ? t('maintenance.continueDraft') : `＋ ${t('maintenance.add')}`}
            </a>
          )}
          {entries.length > 0 && (
            <>
              <button type="button" class="secondary" onClick={exportPdf} disabled={exporting === 'busy'}>
                {exporting === 'busy' ? t('maintenance.exporting') : t('maintenance.exportPdf')}
              </button>
              <button type="button" class="secondary" onClick={exportCsv}>{t('maintenance.exportCsv')}</button>
            </>
          )}
        </div>
        {exporting === 'failed' && <p class="error" role="alert">{t('maintenance.exportFailed')}</p>}

        {entries.length === 0 ? (
          <p class="muted">{t('maintenance.empty')}</p>
        ) : (
          <ul class="entry-list">
            {entries.map((e) => (
              <li key={e.id} class={e.maintenance_voids ? 'voided' : ''}>
                <div class="entry-head">
                  <span class="entry-date">{formatDate(e.performed_on)}</span>
                  <span class="chip">{categoryLabel(e.category)}</span>
                  {e.maintenance_voids && <span class="chip chip-strong">{t('maintenance.voided')}</span>}
                </div>
                <p class="entry-text">{e.description}</p>
                <p class="entry-meta">
                  {t('maintenance.performedBy')}: {e.performed_by} · {t('maintenance.registered')} {formatDateTime(e.created_at)}
                  {names[e.registered_by] && <> ({names[e.registered_by]})</>}
                </p>
                {e.maintenance_voids && (
                  <p class="entry-void">
                    {t('maintenance.voidedReason', { date: formatDateTime(e.maintenance_voids.voided_at) })}: {e.maintenance_voids.reason}
                  </p>
                )}
                {photosFor(e.id).length > 0 && (
                  <div class="photo-grid">
                    {photosFor(e.id).map((p) => (
                      <PhotoThumb key={p.id} url={urls[p.storage_path]} />
                    ))}
                  </div>
                )}
                {isOwnerAdmin && !e.maintenance_voids && (
                  voiding === e.id ? (
                    <VoidForm
                      entryId={e.id}
                      onCancel={() => setVoiding(null)}
                      onDone={() => {
                        setVoiding(null);
                        setReloadKey((k) => k + 1);
                      }}
                    />
                  ) : (
                    <button type="button" class="link-button" onClick={() => setVoiding(e.id)}>{t('maintenance.void')}</button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
