import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import { href } from '../lib/router';
import { toCsv, downloadCsv } from '../lib/csv';
import { STATUSES, type ReviewStatus } from '../lib/status';
import {
  cancelOrder,
  changedShelterIds,
  createOrders,
  fetchStatusRows,
  fetchStatusRowsFor,
  noticeLink,
  type CreateOrdersResult,
  type StatusRow,
} from '../lib/orders';
import { StatusBadge, StatusShape } from '../components/status-badge';
import { StatusMap } from '../components/status-map';

const POLL_MS = 5000;
const PAGE = 100;
// Most urgent first when sorting by status.
const SEVERITY: ReviewStatus[] = ['platsbesok', 'brister', 'forsenad', 'inskickad', 'forelagd', 'godkand', 'ej_forelagd'];

type SortKey = 'status' | 'address' | 'kommun' | 'capacity' | 'due_date' | 'submitted_at' | 'brist_count';

interface Org {
  id: string;
  name: string;
  lanName: string;
}

function inDays(days: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date(Date.now() + days * 86_400_000));
}

function compare(a: StatusRow, b: StatusRow, key: SortKey): number {
  switch (key) {
    case 'status':
      return SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status);
    case 'capacity':
      return a.capacity - b.capacity;
    case 'brist_count':
      return (a.brist_count ?? -1) - (b.brist_count ?? -1);
    case 'due_date':
    case 'submitted_at': {
      const av = a[key] ?? '';
      const bv = b[key] ?? '';
      return av === bv ? 0 : !av ? 1 : !bv ? -1 : av.localeCompare(bv);
    }
    default:
      return (a[key] ?? '').localeCompare(b[key] ?? '', 'sv');
  }
}

function OrderResult({ result }: { result: CreateOrdersResult }) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(token: string) {
    await navigator.clipboard.writeText(noticeLink(token));
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  }
  return (
    <div class="order-result" role="status">
      <p class="stat">{t('lst.order.created', { count: result.created, date: formatDate(result.due_date) })}</p>
      {result.no_owner > 0 && <p class="muted small">{t('lst.order.noOwner', { count: result.no_owner })}</p>}
      {result.already_open > 0 && <p class="muted small">{t('lst.order.alreadyOpen', { count: result.already_open })}</p>}
      {result.outside_lan > 0 && <p class="muted small">{t('lst.order.outsideLan', { count: result.outside_lan })}</p>}
      {result.notices.length > 0 && (
        <>
          <p class="muted small">{t('lst.order.linksIntro')}</p>
          <ul class="link-list">
            {result.notices.map((n) => (
              <li key={n.notice_id}>
                <div class="link-owner">
                  {n.owner_name} <span class="muted">· {t('lst.order.shelterCount', { count: n.shelters })}</span>
                </div>
                <div class="link-row">
                  <input type="text" readOnly value={noticeLink(n.token)} aria-label={t('lst.order.linkFor', { owner: n.owner_name })} onFocus={(e) => e.currentTarget.select()} />
                  <button type="button" class="secondary" onClick={() => copy(n.token)}>
                    {copied === n.token ? t('lst.order.copied') : t('lst.order.copy')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function LstDashboard({ session }: { session: Session }) {
  useLang();
  const [org, setOrg] = useState<Org | null>(null);
  const [rows, setRows] = useState<Map<string, StatusRow>>(new Map());
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [kommun, setKommun] = useState('');
  const [statusFilter, setStatusFilter] = useState<Set<ReviewStatus>>(new Set());
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'status', dir: 1 });
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [due, setDue] = useState(inDays(30));
  const [ordering, setOrdering] = useState(false);
  const [result, setResult] = useState<CreateOrdersResult | null>(null);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<Set<string>>(new Set());
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const since = useRef(new Date(Date.now() - 60_000).toISOString());

  // ------------------------------------------------------------ load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: memberships } = await supabase
        .from('memberships')
        .select('role, organisations(id, name, kind, lan_kod)')
        .eq('user_id', session.user.id);
      const lst = ((memberships ?? []) as unknown as { organisations: { id: string; name: string; kind: string; lan_kod: string } | null }[])
        .map((m) => m.organisations)
        .find((o) => o?.kind === 'lansstyrelse');
      if (!lst) return !cancelled && setPhase('forbidden');
      const [{ data: lan }, all] = await Promise.all([
        supabase.from('lan').select('namn').eq('kod', lst.lan_kod).single(),
        fetchStatusRows(),
      ]);
      if (cancelled) return;
      setOrg({ id: lst.id, name: lst.name, lanName: lan?.namn ?? lst.lan_kod });
      setRows(new Map(all.map((r) => [r.shelter_id, r])));
      setLastSync(new Date());
      setPhase('ready');
    })().catch(() => !cancelled && setPhase('error'));
    return () => {
      cancelled = true;
    };
  }, [session.user.id]);

  // ------------------------------------------------------------ live updates
  async function refresh(ids: string[]) {
    if (!ids.length) return;
    const fresh = await fetchStatusRowsFor(ids);
    setRows((prev) => {
      const next = new Map(prev);
      for (const r of fresh) next.set(r.shelter_id, r);
      return next;
    });
    setRecent(new Set(ids));
    setTimeout(() => setRecent(new Set()), 12_000);
  }

  useEffect(() => {
    if (phase !== 'ready') return;
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const { ids, latest } = await changedShelterIds(since.current);
        if (stopped) return;
        since.current = latest;
        await refresh(ids);
        setLastSync(new Date());
      } catch {
        // Offline for a moment; the next poll catches up.
      }
    };
    const id = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [phase]);

  // ------------------------------------------------------------ derived
  const all = useMemo(() => [...rows.values()], [rows]);
  const kommuner = useMemo(
    () => [...new Map(all.map((r) => [r.kommun_kod, r.kommun])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'sv')),
    [all],
  );
  const inKommun = useMemo(() => (kommun ? all.filter((r) => r.kommun_kod === kommun) : all), [all, kommun]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ReviewStatus, number>;
    for (const r of inKommun) c[r.status]++;
    return c;
  }, [inKommun]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inKommun
      .filter((r) => !statusFilter.size || statusFilter.has(r.status))
      .filter((r) => !q || r.address.toLowerCase().includes(q) || r.shelter_id.toLowerCase().includes(q) || (r.owner_name ?? '').toLowerCase().includes(q))
      .sort((a, b) => compare(a, b, sort.key) * sort.dir || a.address.localeCompare(b.address, 'sv'));
  }, [inKommun, statusFilter, query, sort]);
  const queue = useMemo(
    () => all.filter((r) => r.status === 'inskickad').sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? '')),
    [all],
  );
  const selectedWithoutOwner = useMemo(() => [...selected].filter((id) => !rows.get(id)?.owner_org_id).length, [selected, rows]);

  if (phase === 'loading') return <p class="muted">{t('home.loading')}</p>;
  if (phase !== 'ready' || !org) {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{phase === 'forbidden' ? t('lst.forbidden') : t('home.loadFailed')}</p>
        <a class="button secondary" href={href()}>{t('receipt.back')}</a>
      </section>
    );
  }

  // ------------------------------------------------------------ actions
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const selectMany = (ids: string[]) => setSelected((prev) => new Set([...prev, ...ids]));
  const toggleStatus = (s: ReviewStatus) =>
    setStatusFilter((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  const setSortKey = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }));

  async function submitOrders() {
    setOrdering(true);
    setError('');
    setResult(null);
    try {
      const res = await createOrders(org!.id, [...selected], due);
      setResult(res);
      setSelected(new Set());
      await refresh([...selected]);
    } catch (e) {
      setError(t('lst.order.failed', { message: (e as Error).message }));
    } finally {
      setOrdering(false);
    }
  }

  async function cancel(row: StatusRow) {
    if (!row.order_id || !window.confirm(t('lst.cancelConfirm', { address: row.address }))) return;
    try {
      await cancelOrder(row.order_id);
      await refresh([row.shelter_id]);
    } catch (e) {
      setError(t('lst.order.failed', { message: (e as Error).message }));
    }
  }

  function exportCsv() {
    const csv = toCsv([
      [t('lst.col.id'), t('lst.col.address'), t('lst.col.kommun'), t('lst.col.capacity'), t('lst.col.owner'), t('lst.col.status'), t('lst.col.due'), t('lst.col.submitted'), t('lst.col.brister'), t('lst.col.reviewed')],
      ...filtered.map((r) => [
        r.shelter_id, r.address, r.kommun, r.capacity, r.owner_name ?? '', t(`status.${r.status}`),
        r.due_date ?? '', r.submitted_at ? formatDateTime(r.submitted_at) : '', r.brist_count ?? '', r.reviewed_at ? formatDateTime(r.reviewed_at) : '',
      ]),
    ]);
    downloadCsv(csv, `skyddsrum-status-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  const sortHeader = (key: SortKey, label: string, numeric = false) => (
    <th scope="col" class={numeric ? 'num' : ''} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" class="th-sort" onClick={() => setSortKey(key)}>
        {label} {sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : ''}
      </button>
    </th>
  );

  // ------------------------------------------------------------ render
  return (
    <div class="dashboard">
      <section class="card dash-head">
        <div>
          <div class="eyebrow">{org.name}</div>
          <h1>{t('lst.title', { lan: org.lanName })}</h1>
          <p class="muted small">
            {t('lst.summary', { total: formatNumber(all.length), review: formatNumber(queue.length) })}
            {lastSync && <> · {t('lst.synced', { time: lastSync.toLocaleTimeString('sv-SE') })}</>}
          </p>
        </div>
        <div class="dash-filters">
          <label class="field compact">
            <span>{t('lst.kommun')}</span>
            <select value={kommun} onChange={(e) => { setKommun(e.currentTarget.value); setShown(PAGE); }}>
              <option value="">{t('lst.allKommuner')}</option>
              {kommuner.map(([kod, namn]) => <option key={kod} value={kod}>{namn}</option>)}
            </select>
          </label>
          <label class="field compact grow">
            <span>{t('lst.search')}</span>
            <input type="search" value={query} placeholder={t('lst.searchPlaceholder')} onInput={(e) => { setQuery(e.currentTarget.value); setShown(PAGE); }} />
          </label>
        </div>
        <div class="status-chips" role="group" aria-label={t('lst.statusFilter')}>
          {STATUSES.map((s) => (
            <button key={s} type="button" class="status-chip" aria-pressed={statusFilter.has(s)} onClick={() => { toggleStatus(s); setShown(PAGE); }}>
              <StatusShape status={s} /> {t(`status.${s}`)} <strong>{formatNumber(counts[s])}</strong>
            </button>
          ))}
          {statusFilter.size > 0 && (
            <button type="button" class="link-button" onClick={() => setStatusFilter(new Set())}>{t('lst.clearFilter')}</button>
          )}
        </div>
      </section>

      <div class="dash-grid">
        <section class="card map-card">
          <StatusMap points={filtered} selected={selected} onToggle={toggle} onSelectMany={selectMany} />
          <p class="muted small map-hint">{t('lst.mapHint')}</p>
        </section>

        <aside class="dash-side">
          <section class="card">
            <h2>{t('lst.order.title')}</h2>
            <p class="stat">{t('lst.order.selected', { count: formatNumber(selected.size) })}</p>
            {selectedWithoutOwner > 0 && <p class="muted small">{t('lst.order.selectedNoOwner', { count: selectedWithoutOwner })}</p>}
            <div class="actions wrap">
              <button type="button" class="secondary" onClick={() => selectMany(filtered.map((r) => r.shelter_id))}>
                {t('lst.order.selectFiltered', { count: formatNumber(filtered.length) })}
              </button>
              <button type="button" class="secondary" disabled={!selected.size} onClick={() => setSelected(new Set())}>{t('lst.order.clear')}</button>
            </div>
            <label class="field compact">
              <span>{t('lst.order.due')}</span>
              <input type="date" value={due} min={inDays(1)} max={inDays(365)} onInput={(e) => setDue(e.currentTarget.value)} />
            </label>
            <button type="button" class="primary block-button" disabled={!selected.size || ordering} onClick={submitOrders}>
              {ordering ? t('lst.order.creating') : t('lst.order.create', { count: formatNumber(selected.size) })}
            </button>
            <p class="muted small">{t('lst.order.demoNote')}</p>
            {error && <p class="error" role="alert">{error}</p>}
            {result && <OrderResult result={result} />}
          </section>

          <section class="card">
            <h2>{t('lst.queue.title', { count: formatNumber(queue.length) })}</h2>
            {queue.length === 0 ? (
              <p class="muted small">{t('lst.queue.empty')}</p>
            ) : (
              <ul class="history-list">
                {queue.slice(0, 6).map((r) => (
                  <li key={r.shelter_id}>
                    <a href={href('granska', r.self_check_id!)}>
                      <span class="history-date">{r.address || r.shelter_id}</span>
                      <span class="history-sub">{r.kommun} · {t('lst.queue.submitted', { date: formatDateTime(r.submitted_at!) })}{r.brist_count ? ` · ${t('lst.col.brister')}: ${r.brist_count}` : ''}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      <section class="card table-card">
        <div class="card-head">
          <h2>{t('lst.table.title', { count: formatNumber(filtered.length) })}</h2>
          <button type="button" class="secondary" onClick={exportCsv}>{t('lst.table.csv')}</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col" class="check-col"><span class="visually-hidden">{t('lst.col.select')}</span></th>
                {sortHeader('status', t('lst.col.status'))}
                {sortHeader('address', t('lst.col.address'))}
                {sortHeader('kommun', t('lst.col.kommun'))}
                {sortHeader('capacity', t('lst.col.capacity'), true)}
                <th scope="col">{t('lst.col.owner')}</th>
                {sortHeader('due_date', t('lst.col.due'))}
                {sortHeader('submitted_at', t('lst.col.submitted'))}
                {sortHeader('brist_count', t('lst.col.brister'), true)}
                <th scope="col">{t('lst.col.action')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, shown).map((r) => (
                <tr key={r.shelter_id} class={recent.has(r.shelter_id) ? 'flash' : ''}>
                  <td class="check-col">
                    <input type="checkbox" checked={selected.has(r.shelter_id)} onChange={() => toggle(r.shelter_id)} aria-label={t('lst.col.selectRow', { address: r.address })} />
                  </td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>
                    <div>{r.address || '–'}</div>
                    <div class="cell-sub">{r.shelter_id}</div>
                  </td>
                  <td>{r.kommun}</td>
                  <td class="num">{formatNumber(r.capacity)}</td>
                  <td>{r.owner_name ?? <span class="muted">{t('lst.noOwner')}</span>}</td>
                  <td>{r.due_date && (r.status === 'forelagd' || r.status === 'forsenad') ? formatDate(r.due_date) : ''}</td>
                  <td>{r.submitted_at ? formatDate(r.submitted_at) : ''}</td>
                  <td class="num">{r.brist_count ?? ''}</td>
                  <td>
                    {r.self_check_id ? (
                      <a href={href('granska', r.self_check_id)}>{r.status === 'inskickad' ? t('lst.review') : t('lst.view')}</a>
                    ) : r.status === 'forelagd' || r.status === 'forsenad' ? (
                      <button type="button" class="link-button" onClick={() => cancel(r)}>{t('lst.cancel')}</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > shown && (
          <button type="button" class="secondary block-button" onClick={() => setShown((n) => n + PAGE)}>
            {t('lst.table.more', { shown: formatNumber(shown), total: formatNumber(filtered.length) })}
          </button>
        )}
      </section>
    </div>
  );
}
