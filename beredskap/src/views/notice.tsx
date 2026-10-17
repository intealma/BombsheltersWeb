import { useEffect, useState } from 'preact/hooks';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { formatDate, formatDateTime } from '../lib/format';
import { href } from '../lib/router';

interface NoticeOrder {
  id: string;
  shelter_id: string;
  due_date: string;
  self_check_id: string | null;
  answered_at: string | null;
  cancelled_at: string | null;
  shelters: { address: string; kommuner: { namn: string } | null } | null;
}

interface Notice {
  id: string;
  lst_name: string;
  due_date: string;
  created_at: string;
  orders: NoticeOrder[];
}

/**
 * What an owner sees when opening the link from the länsstyrelse. The token
 * only finds the notice; row-level security shows it only to members of the
 * owner organisation it was issued to.
 */
export function NoticePage({ token }: { token: string }) {
  useLang();
  const [notice, setNotice] = useState<Notice | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('order_notices')
      .select('id, lst_name, due_date, created_at, orders(id, shelter_id, due_date, self_check_id, answered_at, cancelled_at, shelters(address, kommuner(namn)))')
      .eq('token', token)
      .maybeSingle()
      .then(({ data }) => !cancelled && setNotice((data as unknown as Notice) ?? null));
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (notice === undefined) return <p class="muted">{t('home.loading')}</p>;
  if (notice === null) {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{t('notice.notFound')}</p>
        <a class="button secondary" href={href()}>{t('receipt.back')}</a>
      </section>
    );
  }

  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
  const orders = [...notice.orders].sort((a, b) => (a.shelters?.address ?? '').localeCompare(b.shelters?.address ?? '', 'sv'));
  const answered = orders.filter((o) => o.self_check_id).length;
  const overdue = notice.due_date < today && answered < orders.filter((o) => !o.cancelled_at).length;

  return (
    <div class="stack">
      <section class="card">
        <div class="eyebrow">{t('notice.eyebrow')}</div>
        <h1>{t('notice.title')}</h1>
        <p>{t('notice.from', { lst: notice.lst_name, date: formatDate(notice.created_at) })}</p>
        <p class="stat">
          {t('notice.due', { date: formatDate(notice.due_date) })}
          {overdue && <strong> · ⚠ {t('status.forsenad')}</strong>}
        </p>
        <p class="muted small">{t('notice.progress', { done: answered, total: orders.length })}</p>
        <p class="muted small">{t('notice.explain')}</p>
      </section>

      <section class="card">
        <ul class="history-list">
          {orders.map((o) => (
            <li key={o.id}>
              {o.self_check_id ? (
                <a href={href('kontroll', o.self_check_id)}>
                  <span class="history-date">✓ {o.shelters?.address || o.shelter_id}</span>
                  <span class="history-sub">{t('notice.answered', { date: formatDateTime(o.answered_at!) })} · {t('receipt.title')} →</span>
                </a>
              ) : o.cancelled_at ? (
                <div class="history-static">
                  <span class="history-date">{o.shelters?.address || o.shelter_id}</span>
                  <span class="history-sub">{t('notice.cancelled')}</span>
                </div>
              ) : (
                <a href={href('skyddsrum', o.shelter_id, 'kontroll')}>
                  <span class="history-date">{o.shelters?.address || o.shelter_id}</span>
                  <span class="history-sub">{o.shelter_id} · {o.shelters?.kommuner?.namn} · {t('notice.start')} →</span>
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
