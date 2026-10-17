import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { formatNumber, formatPercent } from '../lib/format';
import { href } from '../lib/router';
import { fetchAll, percent } from '../lib/readiness';
import { STATUSES, type MapStatus, type ReviewStatus } from '../lib/status';
import { StatusBadge } from '../components/status-badge';
import { ProgressBar } from '../components/countdown';
import { StatusMap } from '../components/status-map';

type Level = 'coarse' | 'status' | 'details';

interface Overview {
  kommun_kod: string;
  kommun: string;
  detail_level: Level;
  shelters: number;
  capacity: number;
  checked: number;
  approved: number;
  approved_capacity: number;
  status_counts: Partial<Record<ReviewStatus, number>> | null;
}

interface KommunShelter {
  shelter_id: string;
  address: string;
  capacity: number;
  lon: number;
  lat: number;
  status: MapStatus;
  self_check_id: string | null;
}

const LIST_STEP = 25;
const NO_SELECTION = new Set<string>();
const noop = () => undefined;

export function KommunOverview({ session }: { session: Session }) {
  useLang();
  const [overview, setOverview] = useState<Overview[] | null>(null);
  const [shelters, setShelters] = useState<KommunShelter[]>([]);
  const [failed, setFailed] = useState(false);
  const [listed, setListed] = useState(LIST_STEP);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.rpc('kommun_overview'),
      // Large kommuner have more than 1000 shelters: page through.
      fetchAll<KommunShelter>((from, to) => supabase.rpc('kommun_shelters').order('shelter_id').range(from, to)),
    ])
      .then(([o, s]) => {
        if (cancelled) return;
        if (o.error) throw o.error;
        setOverview((o.data ?? []) as Overview[]);
        setShelters(s);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [session.user.id]);

  const approved = useMemo(
    () => shelters.filter((s) => s.status === 'godkand').sort((a, b) => a.address.localeCompare(b.address, 'sv')),
    [shelters],
  );
  const withChecks = useMemo(() => shelters.filter((s) => s.self_check_id), [shelters]);

  if (failed) {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{t('home.loadFailed')}</p>
        <a class="button secondary" href={href()}>{t('receipt.back')}</a>
      </section>
    );
  }
  if (!overview) return <p class="muted">{t('home.loading')}</p>;
  if (overview.length === 0) {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{t('kommun.forbidden')}</p>
        <a class="button secondary" href={href()}>{t('receipt.back')}</a>
      </section>
    );
  }

  return (
    <div class="dashboard">
      {overview.map((o) => (
        <section class="card" key={o.kommun_kod}>
          <div class="eyebrow">{t('kommun.eyebrow')}</div>
          <h1>{t('kommun.title', { kommun: o.kommun })}</h1>
          <p class="notice">{t(`kommun.level.${o.detail_level}`)}</p>

          <div class="kpi-grid">
            <div class="kpi">
              <div class="kpi-label">{t('kommun.shelters')}</div>
              <div class="kpi-value">{formatNumber(o.shelters)}</div>
              <div class="kpi-sub">{t('kommun.places', { count: formatNumber(o.capacity) })}</div>
            </div>
            <div class="kpi">
              <div class="kpi-label">{t('kommun.checked')}</div>
              <div class="kpi-value">{formatPercent(o.checked, o.shelters)}</div>
              <ProgressBar value={percent(o.checked, o.shelters)} label={t('kommun.checked')} />
              <div class="kpi-sub">{t('kommun.ofTotal', { n: formatNumber(o.checked), total: formatNumber(o.shelters) })}</div>
            </div>
            <div class="kpi">
              <div class="kpi-label">{t('kommun.approved')}</div>
              <div class="kpi-value">{formatPercent(o.approved, o.shelters)}</div>
              <ProgressBar value={percent(o.approved, o.shelters)} label={t('kommun.approved')} />
              <div class="kpi-sub">{t('kommun.ofTotal', { n: formatNumber(o.approved), total: formatNumber(o.shelters) })}</div>
            </div>
            <div class="kpi">
              <div class="kpi-label">{t('kommun.approvedPlaces')}</div>
              <div class="kpi-value">{formatPercent(o.approved_capacity, o.capacity)}</div>
              <ProgressBar value={percent(o.approved_capacity, o.capacity)} label={t('kommun.approvedPlaces')} />
              <div class="kpi-sub">{t('kommun.ofTotal', { n: formatNumber(o.approved_capacity), total: formatNumber(o.capacity) })}</div>
            </div>
          </div>

          {o.status_counts && (
            <ul class="status-count-list">
              {STATUSES.map((s) => (
                <li key={s}>
                  <StatusBadge status={s} /> <strong>{formatNumber(o.status_counts![s] ?? 0)}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <div class="dash-grid">
        <section class="card map-card">
          <StatusMap points={shelters} selected={NO_SELECTION} onToggle={noop} onSelectMany={noop} />
          <div class="map-legend">
            {[...new Set(shelters.map((s) => s.status))].sort().map((s) => <StatusBadge key={s} status={s} />)}
          </div>
        </section>

        <aside class="dash-side">
          <section class="card">
            <h2>{t('kommun.approvedList', { count: formatNumber(approved.length) })}</h2>
            <p class="muted small">{t('kommun.approvedIntro')}</p>
            {approved.length === 0 ? (
              <p class="muted">{t('kommun.noneApproved')}</p>
            ) : (
              <ul class="history-list">
                {approved.slice(0, listed).map((s) => (
                  <li key={s.shelter_id}>
                    <div class="history-static">
                      <span class="history-date">{s.address || s.shelter_id}</span>
                      <span class="history-sub">{s.shelter_id} · {t('home.capacity', { capacity: formatNumber(s.capacity) })}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {approved.length > listed && (
              <button type="button" class="secondary block-button" onClick={() => setListed((n) => n + LIST_STEP)}>
                {t('kommun.showMore', { shown: listed, total: approved.length })}
              </button>
            )}
          </section>

          {withChecks.length > 0 && (
            <section class="card">
              <h2>{t('kommun.checksTitle', { count: formatNumber(withChecks.length) })}</h2>
              <ul class="history-list">
                {withChecks.slice(0, 20).map((s) => (
                  <li key={s.shelter_id}>
                    <a href={href('kontroll', s.self_check_id!)}>
                      <span class="history-date">{s.address || s.shelter_id}</span>
                      <span class="history-sub"><StatusBadge status={s.status} /></span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
