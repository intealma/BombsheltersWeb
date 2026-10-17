import { useEffect, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { localized } from '../lib/checklist';
import { checkCounts, formatDateTime, receiptNumber } from '../lib/format';
import { href, navigate } from '../lib/router';
import { signedUrls } from '../lib/photos';
import { reviewSelfCheck } from '../lib/orders';
import type { Status } from '../lib/drafts';
import type { ReviewStatus } from '../lib/status';
import { StatusIcon } from '../components/status-icon';
import { StatusBadge } from '../components/status-badge';

type Decision = 'godkand' | 'brist' | 'platsbesok';
const DECISIONS: Decision[] = ['godkand', 'brist', 'platsbesok'];
const DECISION_STATUS: Record<Decision, ReviewStatus> = { godkand: 'godkand', brist: 'brister', platsbesok: 'platsbesok' };

interface Answer {
  item_id: string;
  position: number;
  item_key: string;
  item_title_sv: string;
  item_title_en: string;
  status: Status;
  comment: string;
}

interface PastReview {
  id: string;
  outcome: ReviewStatus;
  comment: string;
  reviewed_at: string;
}

interface Data {
  check: {
    id: string;
    shelter_id: string;
    inspector_name: string;
    submitted_at: string;
    ok_count: number;
    brist_count: number;
    na_count: number;
    shelters: { address: string; kommuner: { namn: string } | null } | null;
    organisations: { name: string } | null;
  };
  answers: Answer[];
  photos: { id: string; item_key: string | null; storage_path: string }[];
  urls: Record<string, string>;
  reviews: PastReview[];
  canReview: boolean;
}

async function load(checkId: string, userId: string): Promise<Data | null> {
  const [check, answers, photos, reviews, memberships] = await Promise.all([
    supabase
      .from('self_checks')
      .select('id, shelter_id, inspector_name, submitted_at, ok_count, brist_count, na_count, shelters(address, kommuner(namn)), organisations(name)')
      .eq('id', checkId)
      .maybeSingle(),
    supabase.from('self_check_answers').select('*').eq('self_check_id', checkId).order('position'),
    supabase.from('photos').select('id, item_key, storage_path').eq('context', 'self_check').eq('context_id', checkId).order('created_at'),
    supabase.from('self_check_reviews').select('id, outcome, comment, reviewed_at').eq('self_check_id', checkId).order('reviewed_at', { ascending: false }),
    supabase.from('memberships').select('role, organisations(kind)').eq('user_id', userId),
  ]);
  if (!check.data) return null;
  const photoRows = (photos.data ?? []) as Data['photos'];
  const roles = (memberships.data ?? []) as unknown as { role: string; organisations: { kind: string } | null }[];
  return {
    check: check.data as unknown as Data['check'],
    answers: (answers.data ?? []) as Answer[],
    photos: photoRows,
    urls: await signedUrls(photoRows.map((p) => p.storage_path)).catch(() => ({})),
    reviews: (reviews.data ?? []) as PastReview[],
    // The database decides for real; this only hides the form from owners.
    canReview: roles.some((m) => m.organisations?.kind === 'lansstyrelse' && ['inspector', 'lst_admin'].includes(m.role)),
  };
}

export function ReviewPage({ checkId, session }: { checkId: string; session: Session }) {
  useLang();
  const [data, setData] = useState<Data | null | undefined>(undefined);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [overall, setOverall] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<ReviewStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    load(checkId, session.user.id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Start from the owner's own answers: their deficiencies stay deficiencies.
        setDecisions(Object.fromEntries((d?.answers ?? []).map((a) => [a.item_id, a.status === 'brist' ? 'brist' : 'godkand'])));
        setComments({});
        setOverall('');
      })
      .catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [checkId, session.user.id]);

  if (data === undefined) return <p class="muted">{t('home.loading')}</p>;
  if (data === null) {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{t('receipt.notFound')}</p>
        <a class="button secondary" href={href('lansstyrelse')}>{t('review.backToOverview')}</a>
      </section>
    );
  }

  const { check, answers, photos, urls, reviews, canReview } = data;
  const values = answers.map((a) => decisions[a.item_id]);
  const outcome: ReviewStatus = values.includes('platsbesok') ? 'platsbesok' : values.includes('brist') ? 'brister' : 'godkand';

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await reviewSelfCheck(
        check.id,
        answers.map((a) => ({ item_id: a.item_id, decision: decisions[a.item_id], comment: comments[a.item_id] ?? '' })),
        overall,
      );
      setSaved(res.outcome as ReviewStatus);
      setData((d) => d && { ...d, reviews: [{ id: res.id, outcome: res.outcome as ReviewStatus, comment: overall, reviewed_at: new Date().toISOString() }, ...d.reviews] });
    } catch (e) {
      setError(t('review.failed', { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    const { data: row } = await supabase
      .from('shelter_review_status')
      .select('self_check_id')
      .eq('status', 'inskickad')
      .order('submitted_at')
      .limit(1)
      .maybeSingle();
    if (row?.self_check_id) navigate('granska', row.self_check_id);
    else navigate('lansstyrelse');
  }

  return (
    <div class="review">
      {canReview ? (
        <a class="link-button back-link" href={href('lansstyrelse')}>← {t('review.backToOverview')}</a>
      ) : (
        <a class="link-button back-link" href={href('skyddsrum', check.shelter_id)}>← {t('review.backToShelter')}</a>
      )}

      <section class="card">
        <div class="eyebrow">{t('review.eyebrow')}</div>
        <h1>{check.shelters?.address || check.shelter_id}</h1>
        <dl class="meta">
          <dt>{t('receipt.shelter')}</dt>
          <dd>{check.shelter_id} · {check.shelters?.kommuner?.namn}</dd>
          <dt>{t('receipt.owner')}</dt>
          <dd>{check.organisations?.name}</dd>
          <dt>{t('receipt.inspector')}</dt>
          <dd>{check.inspector_name}</dd>
          <dt>{t('receipt.submittedAt')}</dt>
          <dd>{formatDateTime(check.submitted_at)}</dd>
          <dt>{t('receipt.number')}</dt>
          <dd>{receiptNumber(check.id)}</dd>
          <dt>{t('receipt.summary')}</dt>
          <dd>{checkCounts(check.ok_count, check.brist_count, check.na_count)}</dd>
        </dl>
        {reviews.length > 0 && (
          <div class="past-reviews">
            <h2>{t('review.history')}</h2>
            <ul class="history-list">
              {reviews.map((r) => (
                <li key={r.id}>
                  <div class="history-row">
                    <StatusBadge status={r.outcome} />
                    <span class="history-sub">{formatDateTime(r.reviewed_at)}</span>
                  </div>
                  {r.comment && <p class="answer-comment">{r.comment}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section class="card">
        <ul class="answer-list review-list">
          {answers.map((a) => {
            const itemPhotos = photos.filter((p) => p.item_key === a.item_key);
            return (
              <li key={a.item_id}>
                <div class="answer-head">
                  <StatusIcon status={a.status} />
                  <div class="answer-title">
                    {a.position}. {localized(a, 'item_title')}
                    <div class={`answer-status status-${a.status}`}>{t('review.ownerSaid')}: {t(`check.status.${a.status}`)}</div>
                  </div>
                </div>
                {a.comment && <p class="answer-comment">{a.comment}</p>}
                {itemPhotos.length > 0 && (
                  <div class="photo-grid large">
                    {itemPhotos.map((p) =>
                      urls[p.storage_path] ? (
                        <a key={p.id} class="thumb" href={urls[p.storage_path]} target="_blank" rel="noopener noreferrer">
                          <img src={urls[p.storage_path]} alt={t('review.photoAlt', { item: localized(a, 'item_title') })} loading="lazy" />
                        </a>
                      ) : null,
                    )}
                  </div>
                )}
                {canReview && !saved && (
                  <div class="decision">
                    <div class="decision-buttons" role="group" aria-label={t('review.decisionFor', { item: localized(a, 'item_title') })}>
                      {DECISIONS.map((d) => (
                        <button
                          key={d}
                          type="button"
                          class="decision-btn"
                          aria-pressed={decisions[a.item_id] === d}
                          onClick={() => setDecisions((prev) => ({ ...prev, [a.item_id]: d }))}
                        >
                          <StatusBadge status={DECISION_STATUS[d]} />
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      class="decision-comment"
                      maxLength={2000}
                      placeholder={t('review.itemComment')}
                      value={comments[a.item_id] ?? ''}
                      onInput={(e) => setComments((prev) => ({ ...prev, [a.item_id]: e.currentTarget.value }))}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {canReview && (
        <section class="card">
          {saved ? (
            <div role="status">
              <p class="stat">{t('review.saved')}</p>
              <StatusBadge status={saved} />
              <div class="actions">
                <button type="button" class="primary" onClick={next}>{t('review.next')}</button>
                <a class="button secondary" href={href('lansstyrelse')}>{t('review.backToOverview')}</a>
              </div>
            </div>
          ) : (
            <>
              <h2>{t('review.result')}</h2>
              <StatusBadge status={outcome} />
              <p class="muted small">{t('review.resultHint')}</p>
              <label class="field">
                <span>{t('review.overallComment')}</span>
                <textarea rows={3} maxLength={4000} value={overall} onInput={(e) => setOverall(e.currentTarget.value)} />
              </label>
              {error && <p class="error" role="alert">{error}</p>}
              <button type="button" class="primary block-button" onClick={submit} disabled={busy}>
                {busy ? t('review.saving') : t('review.submit')}
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
