import { useEffect, useState } from 'preact/hooks';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { localized } from '../lib/checklist';
import { checkCounts, formatDateTime, receiptNumber } from '../lib/format';
import { signedUrls } from '../lib/photos';
import { href } from '../lib/router';
import { downloadReceiptPdf } from '../lib/pdf';
import { StatusIcon } from '../components/status-icon';
import type { Status } from '../lib/drafts';

interface CheckRow {
  id: string;
  shelter_id: string;
  inspector_name: string;
  submitted_at: string;
  ok_count: number;
  brist_count: number;
  na_count: number;
  shelters: { address: string; kommuner: { namn: string } | null } | null;
  organisations: { name: string } | null;
  checklist_templates: { title_sv: string; title_en: string; is_placeholder: boolean } | null;
}

interface AnswerRow {
  item_id: string;
  position: number;
  item_key: string;
  item_title_sv: string;
  item_title_en: string;
  status: Status;
  comment: string;
}

interface PhotoRow {
  id: string;
  item_key: string | null;
  storage_path: string;
}

type State =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; check: CheckRow; answers: AnswerRow[]; photos: PhotoRow[]; urls: Record<string, string> };

async function load(checkId: string): Promise<State> {
  const [check, answers, photos] = await Promise.all([
    supabase
      .from('self_checks')
      .select('id, shelter_id, inspector_name, submitted_at, ok_count, brist_count, na_count, shelters(address, kommuner(namn)), organisations(name), checklist_templates(title_sv, title_en, is_placeholder)')
      .eq('id', checkId)
      .maybeSingle(),
    supabase.from('self_check_answers').select('*').eq('self_check_id', checkId).order('position'),
    supabase.from('photos').select('id, item_key, storage_path').eq('context', 'self_check').eq('context_id', checkId).order('created_at'),
  ]);
  if (!check.data) return { status: 'missing' };
  const photoRows = (photos.data ?? []) as PhotoRow[];
  const urls = await signedUrls(photoRows.map((p) => p.storage_path)).catch(() => ({}));
  return {
    status: 'ready',
    check: check.data as unknown as CheckRow,
    answers: (answers.data ?? []) as AnswerRow[],
    photos: photoRows,
    urls,
  };
}

export function Receipt({ checkId }: { checkId: string }) {
  useLang();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [pdf, setPdf] = useState<'idle' | 'busy' | 'failed'>('idle');

  useEffect(() => {
    let cancelled = false;
    load(checkId)
      .then((s) => !cancelled && setState(s))
      .catch(() => !cancelled && setState({ status: 'missing' }));
    return () => {
      cancelled = true;
    };
  }, [checkId]);

  if (state.status === 'loading') return <p class="muted">{t('home.loading')}</p>;
  if (state.status === 'missing') {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{t('receipt.notFound')}</p>
        <a class="button secondary" href={href()}>{t('receipt.back')}</a>
      </section>
    );
  }

  const { check, answers, photos, urls } = state;
  const shelterAddress = check.shelters?.address || check.shelter_id;
  const kommun = check.shelters?.kommuner?.namn ?? '';
  const photosFor = (key: string) => photos.filter((p) => p.item_key === key);

  async function download() {
    setPdf('busy');
    try {
      // Fresh links: the ones on screen may have expired.
      const fresh = await signedUrls(photos.map((p) => p.storage_path), 120);
      await downloadReceiptPdf({
        id: check.id,
        shelterId: check.shelter_id,
        shelterAddress,
        kommun,
        ownerName: check.organisations?.name ?? '',
        inspectorName: check.inspector_name,
        submittedAt: check.submitted_at,
        checklistTitle: check.checklist_templates ? localized(check.checklist_templates, 'title') : '',
        isPlaceholder: check.checklist_templates?.is_placeholder ?? false,
        counts: { ok: check.ok_count, brist: check.brist_count, na: check.na_count },
        items: answers.map((a) => ({
          position: a.position,
          title: localized(a, 'item_title'),
          status: a.status,
          comment: a.comment,
          photoUrls: photosFor(a.item_key).map((p) => fresh[p.storage_path]).filter(Boolean),
        })),
      });
      setPdf('idle');
    } catch {
      setPdf('failed');
    }
  }

  return (
    <div class="stack">
      <a class="link-button back-link" href={href()}>← {t('receipt.back')}</a>
      <section class="card">
        <div class="receipt-badge">
          <StatusIcon status="ok" class="status-icon" /> {t('receipt.submitted')}
        </div>
        <h1>{t('receipt.title')}</h1>
        <dl class="meta">
          <dt>{t('receipt.number')}</dt>
          <dd><strong>{receiptNumber(check.id)}</strong> <span class="muted small">{check.id}</span></dd>
          <dt>{t('receipt.shelter')}</dt>
          <dd>{shelterAddress}, {kommun} <span class="muted small">({check.shelter_id})</span></dd>
          <dt>{t('receipt.owner')}</dt>
          <dd>{check.organisations?.name}</dd>
          <dt>{t('receipt.inspector')}</dt>
          <dd>{check.inspector_name}</dd>
          <dt>{t('receipt.submittedAt')}</dt>
          <dd>{formatDateTime(check.submitted_at)}</dd>
          <dt>{t('receipt.summary')}</dt>
          <dd>{checkCounts(check.ok_count, check.brist_count, check.na_count)}</dd>
        </dl>
        {check.checklist_templates?.is_placeholder && <p class="notice">{t('check.placeholder')}</p>}
        <div class="actions">
          <button type="button" class="primary" onClick={download} disabled={pdf === 'busy'}>
            {pdf === 'busy' ? t('receipt.generating') : t('receipt.download')}
          </button>
        </div>
        {pdf === 'failed' && <p class="error" role="alert">{t('receipt.pdfFailed')}</p>}
      </section>

      <section class="card">
        <ul class="answer-list">
          {answers.map((a) => (
            <li key={a.item_id}>
              <div class="answer-head">
                <StatusIcon status={a.status} />
                <div class="answer-title">
                  {a.position}. {localized(a, 'item_title')}
                  <div class={`answer-status status-${a.status}`}>{t(`check.status.${a.status}`)}</div>
                </div>
              </div>
              {a.comment && <p class="answer-comment">{a.comment}</p>}
              {photosFor(a.item_key).length > 0 && (
                <div class="photo-grid">
                  {photosFor(a.item_key).map((p) => (
                    <div class="thumb" key={p.id}>
                      {urls[p.storage_path] && <img src={urls[p.storage_path]} alt="" loading="lazy" />}
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
