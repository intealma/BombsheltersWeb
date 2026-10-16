import { useEffect, useRef, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import {
  deleteMaintenanceDraft,
  deletePhoto,
  getMaintenanceDraft,
  getPhotos,
  markPhotoUploaded,
  saveMaintenanceDraft,
  type DraftPhoto,
  type MaintenanceDraft,
} from '../lib/drafts';
import { addEntry, CATEGORIES, categoryLabel, todayInSweden } from '../lib/maintenance';
import { uploadPhoto, UploadError } from '../lib/photos';
import { href, navigate } from '../lib/router';
import { AddPhotoButton, PhotoThumb } from '../components/photos';

type Phase = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' } | { kind: 'saving'; label: string };

function isNetworkError(e: unknown): boolean {
  if (e instanceof UploadError) return e.status === 0;
  return !navigator.onLine || /failed to fetch|network|load failed/i.test((e as { message?: string })?.message ?? '');
}

function twoYearsAgo(today: string): string {
  const [y, m, d] = today.split('-');
  return `${Number(y) - 2}-${m}-${d}`;
}

export function MaintenanceForm({ shelterId, session }: { shelterId: string; session: Session }) {
  useLang();
  const [draft, setDraft] = useState<MaintenanceDraft | null>(null);
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const [shelterLabel, setShelterLabel] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [notice, setNotice] = useState('');
  const latest = useRef<MaintenanceDraft | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const today = todayInSweden();

  latest.current = draft;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await getMaintenanceDraft(session.user.id, shelterId);
        const shelter = navigator.onLine
          ? await supabase.from('shelters').select('id, address, kommuner(namn)').eq('id', shelterId).maybeSingle()
          : { data: null };
        if (cancelled) return;
        const s = shelter.data as unknown as { id: string; address: string; kommuner: { namn: string } | null } | null;
        setShelterLabel(s ? `${s.address || s.id} · ${s.id} · ${s.kommuner?.namn ?? ''}` : shelterId);

        if (existing) {
          setDraft(existing);
          setPhotos(await getPhotos(existing.id));
          setPhase({ kind: 'ready' });
          return;
        }
        if (!navigator.onLine) throw new Error('offline');

        const [membership, profile] = await Promise.all([
          supabase.from('memberships').select('role').eq('user_id', session.user.id).in('role', ['owner_admin', 'caretaker']),
          supabase.from('profiles').select('full_name').eq('user_id', session.user.id).maybeSingle(),
        ]);
        if (cancelled) return;
        if (!membership.data?.length || !s) {
          setPhase({ kind: 'error', message: t('shelter.notFound') });
          return;
        }
        setDraft({
          id: crypto.randomUUID(),
          userId: session.user.id,
          shelterId,
          performedOn: todayInSweden(),
          category: '',
          description: '',
          performedBy: profile.data?.full_name ?? '',
          updatedAt: new Date().toISOString(),
        });
        setPhase({ kind: 'ready' });
      } catch (e) {
        if (!cancelled) setPhase({ kind: 'error', message: isNetworkError(e) ? t('check.needOnline') : t('home.loadFailed') });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shelterId, session.user.id]);

  // Nothing is stored until the user changes something; from then on every
  // change is saved on the device.
  function update(patch: Partial<MaintenanceDraft>) {
    const next = { ...latest.current!, ...patch };
    latest.current = next;
    setDraft(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveMaintenanceDraft(next), 300);
  }

  async function removePhoto(photo: DraftPhoto) {
    await deletePhoto(photo.id);
    setPhotos((p) => p.filter((x) => x.id !== photo.id));
  }

  async function discard() {
    if (!draft || !window.confirm(t('maintenance.discardConfirm'))) return;
    await deleteMaintenanceDraft(draft.id);
    navigate('skyddsrum', shelterId);
  }

  async function save(e: Event) {
    e.preventDefault();
    const d = latest.current!;
    if (!d.performedOn || d.performedOn > today || d.performedOn < twoYearsAgo(today)) return setNotice(t('maintenance.dateInvalid'));
    if (!d.category) return setNotice(t('maintenance.categoryMissing'));
    if (d.description.trim().length < 3) return setNotice(t('maintenance.descriptionMissing'));
    if (d.performedBy.trim().length < 2) return setNotice(t('maintenance.performedByMissing'));
    setNotice('');
    clearTimeout(saveTimer.current);
    await saveMaintenanceDraft(d);

    try {
      const pending = photos.filter((p) => !p.uploaded);
      for (let i = 0; i < pending.length; i++) {
        setPhase({ kind: 'saving', label: t('maintenance.uploading', { done: i + 1, total: pending.length }) });
        await uploadPhoto(pending[i], d.shelterId, 'maintenance');
        await markPhotoUploaded(pending[i]);
        setPhotos((all) => all.map((p) => (p.id === pending[i].id ? { ...p, uploaded: true } : p)));
      }
      setPhase({ kind: 'saving', label: t('maintenance.saving') });
      await addEntry(d);
      await deleteMaintenanceDraft(d.id);
      navigate('skyddsrum', shelterId);
    } catch (err) {
      setPhase({ kind: 'ready' });
      setNotice(isNetworkError(err) ? t('maintenance.offline') : t('maintenance.saveFailed', { message: (err as Error).message }));
    }
  }

  if (phase.kind === 'loading') return <p class="muted">{t('home.loading')}</p>;
  if (phase.kind === 'error' || !draft) {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{phase.kind === 'error' ? phase.message : ''}</p>
        <a class="button secondary" href={href('skyddsrum', shelterId)}>← {t('receipt.back')}</a>
      </section>
    );
  }

  const busy = phase.kind === 'saving';
  const hasContent = draft.description.trim() || photos.length > 0;

  return (
    <form class="check" onSubmit={save}>
      <div class="check-header">
        <a class="link-button back-link" href={href('skyddsrum', shelterId)}>← {t('maintenance.title')}</a>
        <div class="eyebrow">{t('maintenance.title')}</div>
        <div class="check-shelter">{shelterLabel}</div>
      </div>

      <section class="card">
        <h1>{t('maintenance.formTitle')}</h1>

        <label class="field">
          <span>{t('maintenance.performedOn')}</span>
          <input
            type="date"
            required
            max={today}
            min={twoYearsAgo(today)}
            value={draft.performedOn}
            disabled={busy}
            onInput={(e) => update({ performedOn: e.currentTarget.value })}
          />
        </label>

        <label class="field">
          <span>{t('maintenance.categoryLabel')}</span>
          <select required value={draft.category} disabled={busy} onChange={(e) => update({ category: e.currentTarget.value })}>
            <option value="" disabled>—</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{categoryLabel(c)}</option>
            ))}
          </select>
        </label>

        <label class="field">
          <span>{t('maintenance.description')}</span>
          <textarea
            rows={4}
            required
            maxLength={4000}
            placeholder={t('maintenance.descriptionPlaceholder')}
            value={draft.description}
            disabled={busy}
            onInput={(e) => update({ description: e.currentTarget.value })}
          />
        </label>

        <label class="field">
          <span>{t('maintenance.performedBy')} <span class="muted">({t('maintenance.performedByHint')})</span></span>
          <input
            type="text"
            required
            maxLength={200}
            autocomplete="organization"
            value={draft.performedBy}
            disabled={busy}
            onInput={(e) => update({ performedBy: e.currentTarget.value })}
          />
        </label>

        <div class="field">
          <span>{t('maintenance.photos')} <span class="muted">{t('check.photoOptional')}</span></span>
          {photos.length > 0 && (
            <div class="photo-grid">
              {photos.map((p) => (
                <PhotoThumb key={p.id} blob={p.blob} onRemove={p.uploaded || busy ? undefined : () => removePhoto(p)} />
              ))}
            </div>
          )}
          <AddPhotoButton
            draftId={draft.id}
            itemKey=""
            onAdded={(photo) => {
              setPhotos((all) => [...all, photo]);
              update({}); // keep the draft once it has a photo
            }}
            onError={setNotice}
          />
        </div>

        {notice && <p class="error" role="alert">{notice}</p>}
        {phase.kind === 'saving' && <p class="notice" role="status">{phase.label}</p>}
        {hasContent && <p class="saved-hint">{t('check.saved')}</p>}
      </section>

      <div class="step-nav">
        {hasContent && (
          <button type="button" class="secondary" onClick={discard} disabled={busy}>{t('maintenance.discard')}</button>
        )}
        <button type="submit" class="primary" disabled={busy}>{busy ? t('maintenance.saving') : t('maintenance.save')}</button>
      </div>
    </form>
  );
}
