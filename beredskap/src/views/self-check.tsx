import { useEffect, useRef, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { fetchActiveTemplate, localized, photoRequired, submitSelfCheck, type ChecklistItem } from '../lib/checklist';
import {
  addPhoto,
  deleteDraft,
  deletePhoto,
  getDraftForShelter,
  getPhotos,
  markPhotoUploaded,
  saveDraft,
  type Draft,
  type DraftPhoto,
  type Status,
} from '../lib/drafts';
import { prepareImage, uploadPhoto, UploadError } from '../lib/photos';
import { href, navigate } from '../lib/router';
import { StatusIcon } from '../components/status-icon';
import { checkCounts } from '../lib/format';

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }
  | { kind: 'sending'; label: string }
  | { kind: 'send-error'; message: string };

const STATUSES: Status[] = ['ok', 'brist', 'ej_tillampligt'];

function isNetworkError(e: unknown): boolean {
  if (e instanceof UploadError) return e.status === 0;
  const message = (e as { message?: string })?.message ?? '';
  return !navigator.onLine || /failed to fetch|network|load failed/i.test(message);
}

function PhotoThumb({ photo, onRemove }: { photo: DraftPhoto; onRemove?: () => void }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(photo.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [photo.blob]);
  return (
    <div class="thumb">
      {url && <img src={url} alt="" />}
      {onRemove && (
        <button type="button" class="thumb-remove" aria-label={t('check.removePhoto')} onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}

export function SelfCheck({ shelterId, session }: { shelterId: string; session: Session }) {
  useLang();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [notice, setNotice] = useState('');
  const [persisted, setPersisted] = useState(false);
  const latest = useRef<Draft | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const headingRef = useRef<HTMLHeadingElement>(null);

  latest.current = draft;

  // ---------------------------------------------------------------- loading
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await getDraftForShelter(session.user.id, shelterId);
        if (existing) {
          const existingPhotos = await getPhotos(existing.id);
          if (cancelled) return;
          setDraft(existing);
          setPhotos(existingPhotos);
          setPersisted(true);
          setPhase({ kind: 'ready' });
          return;
        }
        if (!navigator.onLine) throw new Error('offline');

        const [membership, shelter, template, profile] = await Promise.all([
          supabase.from('memberships').select('role').eq('user_id', session.user.id).in('role', ['owner_admin', 'caretaker']),
          supabase.from('shelters').select('id, address, kommuner(namn)').eq('id', shelterId).maybeSingle(),
          fetchActiveTemplate(),
          supabase.from('profiles').select('full_name').eq('user_id', session.user.id).maybeSingle(),
        ]);
        if (cancelled) return;
        if (!membership.data?.length || !shelter.data) {
          setPhase({ kind: 'error', message: t('check.noShelter') });
          return;
        }
        const now = new Date().toISOString();
        const s = shelter.data as unknown as { id: string; address: string; kommuner: { namn: string } | null };
        setDraft({
          id: crypto.randomUUID(),
          userId: session.user.id,
          shelterId,
          shelterAddress: s.address || s.id,
          kommun: s.kommuner?.namn ?? '',
          template,
          inspectorName: profile.data?.full_name ?? '',
          startedAt: now,
          updatedAt: now,
          step: 0,
          answers: {},
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

  // Save right away when the page is hidden (phone locked, app switched).
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden' && persisted && latest.current) {
        clearTimeout(saveTimer.current);
        saveDraft(latest.current);
      }
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [persisted]);

  useEffect(() => {
    headingRef.current?.focus();
    setNotice('');
  }, [draft?.step]);

  // ----------------------------------------------------------------- state
  function update(change: (d: Draft) => Draft, immediate = false) {
    const next = change(latest.current!);
    latest.current = next;
    setDraft(next);
    if (!persisted && next.step === 0) return; // nothing to keep until the check is started
    setPersisted(true);
    clearTimeout(saveTimer.current);
    if (immediate) saveDraft(next);
    else saveTimer.current = setTimeout(() => saveDraft(next), 300);
  }

  const goTo = (step: number) => update((d) => ({ ...d, step }), true);

  function setAnswer(item: ChecklistItem, patch: Partial<{ status: Status; comment: string }>, immediate = false) {
    update(
      (d) => ({
        ...d,
        answers: {
          ...d.answers,
          [item.id]: { ...d.answers[item.id], ...patch, comment: patch.comment ?? d.answers[item.id]?.comment ?? '' },
        },
      }),
      immediate,
    );
  }

  async function onFiles(item: ChecklistItem, input: HTMLInputElement) {
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      try {
        const { blob, width, height } = await prepareImage(file);
        const photo: DraftPhoto = {
          id: crypto.randomUUID(),
          draftId: latest.current!.id,
          itemKey: item.key,
          blob,
          width,
          height,
          uploaded: false,
          createdAt: new Date().toISOString(),
        };
        await addPhoto(photo);
        setPhotos((p) => [...p, photo]);
        setNotice('');
      } catch {
        setNotice(t('check.photoFailed'));
      }
    }
  }

  async function removePhoto(photo: DraftPhoto) {
    await deletePhoto(photo.id);
    setPhotos((p) => p.filter((x) => x.id !== photo.id));
  }

  async function discard() {
    if (!draft || !window.confirm(t('check.discardConfirm'))) return;
    await deleteDraft(draft.id);
    navigate();
  }

  // ---------------------------------------------------------------- submit
  const photosFor = (item: ChecklistItem) => photos.filter((p) => p.itemKey === item.key);
  const missingPhoto = (item: ChecklistItem) =>
    photoRequired(item, draft?.answers[item.id]?.status) && photosFor(item).length === 0;

  async function send() {
    const d = latest.current!;
    if (d.inspectorName.trim().length < 2) return setNotice(t('check.nameMissing'));
    if (d.template.items.some((i) => !d.answers[i.id]?.status || missingPhoto(i))) return setNotice(t('check.incomplete'));
    clearTimeout(saveTimer.current);
    await saveDraft(d);

    try {
      const pending = photos.filter((p) => !p.uploaded);
      for (let i = 0; i < pending.length; i++) {
        setPhase({ kind: 'sending', label: t('check.uploading', { done: i + 1, total: pending.length }) });
        await uploadPhoto(pending[i], d.shelterId, 'self_check');
        await markPhotoUploaded(pending[i]);
        setPhotos((all) => all.map((p) => (p.id === pending[i].id ? { ...p, uploaded: true } : p)));
      }
      setPhase({ kind: 'sending', label: t('check.sending') });
      const row = await submitSelfCheck(d);
      await deleteDraft(d.id);
      navigate('kontroll', row.id);
    } catch (e) {
      setPhase({
        kind: 'send-error',
        message: isNetworkError(e) ? t('check.offline') : t('check.sendFailed', { message: (e as Error).message }),
      });
    }
  }

  // ---------------------------------------------------------------- render
  if (phase.kind === 'loading') return <p class="muted">{t('home.loading')}</p>;
  if (phase.kind === 'error' || !draft) {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{phase.kind === 'error' ? phase.message : ''}</p>
        <a class="button secondary" href={href()}>{t('receipt.back')}</a>
      </section>
    );
  }

  const items = draft.template.items;
  const total = items.length;
  const step = Math.min(Math.max(draft.step, 0), total + 1);
  const busy = phase.kind === 'sending';
  const header = (
    <div class="check-header">
      <a class="link-button back-link" href={href()}>← {t('receipt.back')}</a>
      <div class="eyebrow">{t('check.eyebrow')}</div>
      <div class="check-shelter">
        {draft.shelterAddress} <span class="muted">· {draft.shelterId} · {draft.kommun}</span>
      </div>
      {step > 0 && (
        <div class="progress" aria-hidden="true">
          <span style={{ width: `${(Math.min(step, total) / total) * 100}%` }} />
        </div>
      )}
    </div>
  );

  // Intro
  if (step === 0) {
    const resuming = persisted && Object.keys(draft.answers).length > 0;
    return (
      <div class="check">
        {header}
        <section class="card">
          <h1 ref={headingRef} tabIndex={-1}>{localized(draft.template, 'title')}</h1>
          {draft.template.is_placeholder && <p class="notice">{t('check.placeholder')}</p>}
          <p class="muted">{t('check.intro', { count: total })}</p>
          <label class="field">
            <span>{t('check.inspectorName')}</span>
            <input
              type="text"
              autocomplete="name"
              maxLength={120}
              value={draft.inspectorName}
              onInput={(e) => update((d) => ({ ...d, inspectorName: e.currentTarget.value }))}
            />
          </label>
          {notice && <p class="error" role="alert">{notice}</p>}
        </section>
        <div class="step-nav">
          {resuming && (
            <button type="button" class="secondary" onClick={discard}>{t('check.discard')}</button>
          )}
          <button
            type="button"
            class="primary"
            onClick={() => (draft.inspectorName.trim().length < 2 ? setNotice(t('check.nameMissing')) : goTo(resuming ? draft.step || 1 : 1))}
          >
            {resuming ? t('check.resume') : t('check.start')}
          </button>
        </div>
      </div>
    );
  }

  // Summary
  if (step === total + 1) {
    const answers = items.map((i) => draft.answers[i.id]?.status);
    const count = (s: Status) => answers.filter((a) => a === s).length;
    return (
      <div class="check">
        {header}
        <section class="card">
          <h1 ref={headingRef} tabIndex={-1}>{t('check.summary')}</h1>
          <p class="muted small">{t('check.summaryHint')}</p>
          <ul class="summary-list">
            {items.map((item, i) => {
              const status = draft.answers[item.id]?.status;
              const problem = !status ? t('check.notAnswered') : missingPhoto(item) ? t('check.missingPhoto') : '';
              return (
                <li key={item.id}>
                  <button type="button" onClick={() => goTo(i + 1)} disabled={busy}>
                    <StatusIcon status={status} />
                    <span class="summary-title">
                      {i + 1}. {localized(item, 'title')}
                      {problem && <span class="summary-problem">{problem}</span>}
                    </span>
                    <span class="summary-status">{status ? t(`check.status.${status}`) : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p class="stat">{checkCounts(count('ok'), count('brist'), count('ej_tillampligt'))}</p>
          <label class="field">
            <span>{t('check.inspectorName')}</span>
            <input
              type="text"
              autocomplete="name"
              maxLength={120}
              value={draft.inspectorName}
              disabled={busy}
              onInput={(e) => update((d) => ({ ...d, inspectorName: e.currentTarget.value }))}
            />
          </label>
          {notice && <p class="error" role="alert">{notice}</p>}
          {phase.kind === 'sending' && <p class="notice" role="status">{phase.label}</p>}
          {phase.kind === 'send-error' && <p class="error" role="alert">{phase.message}</p>}
        </section>
        <div class="step-nav">
          <button type="button" class="secondary" onClick={() => goTo(total)} disabled={busy}>{t('check.back')}</button>
          <button type="button" class="primary" onClick={send} disabled={busy}>
            {phase.kind === 'send-error' ? t('check.retry') : t('check.submit')}
          </button>
        </div>
      </div>
    );
  }

  // One checklist item per screen
  const item = items[step - 1];
  const answer = draft.answers[item.id];
  const itemPhotos = photosFor(item);
  const required = photoRequired(item, answer?.status);
  const titleId = `item-${item.key}`;

  function next() {
    if (!answer?.status) return setNotice(t('check.chooseStatus'));
    if (missingPhoto(item)) return setNotice(t('check.photoRequired'));
    goTo(step + 1);
  }

  return (
    <div class="check">
      {header}
      <section class="card">
        <div class="eyebrow">{t('check.step', { n: step, total })}</div>
        <h1 id={titleId} ref={headingRef} tabIndex={-1}>{localized(item, 'title')}</h1>
        {localized(item, 'help') && <p class="muted">{localized(item, 'help')}</p>}

        <div class="status-group" role="group" aria-labelledby={titleId}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              class="status-btn"
              aria-pressed={answer?.status === s}
              onClick={() => setAnswer(item, { status: s }, true)}
            >
              <StatusIcon status={s} />
              <span>{t(`check.status.${s}`)}</span>
            </button>
          ))}
        </div>

        <div class="field">
          <span>
            {t('check.photos')} <span class={required ? 'required' : 'muted'}>{required ? t('check.photoRequired') : t('check.photoOptional')}</span>
          </span>
          {itemPhotos.length > 0 && (
            <div class="photo-grid">
              {itemPhotos.map((p) => (
                <PhotoThumb key={p.id} photo={p} onRemove={p.uploaded ? undefined : () => removePhoto(p)} />
              ))}
            </div>
          )}
          <label class="add-photo">
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              class="visually-hidden"
              onChange={(e) => onFiles(item, e.currentTarget)}
            />
            <span aria-hidden="true">＋</span> {t('check.addPhoto')}
          </label>
        </div>

        <label class="field">
          <span>{t('check.comment')}</span>
          <textarea
            rows={3}
            maxLength={2000}
            placeholder={t('check.commentPlaceholder')}
            value={answer?.comment ?? ''}
            onInput={(e) => setAnswer(item, { comment: e.currentTarget.value })}
          />
        </label>
        {notice && <p class="error" role="alert">{notice}</p>}
        <p class="saved-hint">{t('check.saved')}</p>
      </section>
      <div class="step-nav">
        <button type="button" class="secondary" onClick={() => goTo(step - 1)}>{t('check.back')}</button>
        <button type="button" class="primary" onClick={next}>
          {step === total ? t('check.toSummary') : t('check.next')}
        </button>
      </div>
    </div>
  );
}
