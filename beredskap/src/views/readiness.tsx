import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { localized } from '../lib/checklist';
import { formatDateTime, formatNumber } from '../lib/format';
import { href } from '../lib/router';
import {
  deleteContact,
  endSimulation,
  fetchActiveActivation,
  fetchAll,
  fetchCompletions,
  fetchContacts,
  fetchLastEndedActivation,
  fetchTasks,
  fetchTemplates,
  percent,
  saveContact,
  setupPlans,
  startSimulation,
  taskDeadline,
  type Activation,
  type Completion,
  type Contact,
  type ReadinessTask,
  type TaskTemplate,
} from '../lib/readiness';
import { Countdown, ProgressBar, useNow } from '../components/countdown';
import { READINESS_CHANGED } from '../components/simulation-banner';

const POLL_MS = 5000;

interface Org {
  id: string;
  name: string;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      org: Org;
      isAdmin: boolean;
      shelters: { id: string; address: string }[];
      templates: TaskTemplate[];
      tasks: ReadinessTask[];
      contacts: Contact[];
      activation: Activation | null;
      lastEnded: Activation | null;
    };

async function load(userId: string): Promise<State> {
  const { data: memberships } = await supabase
    .from('memberships')
    .select('role, organisations(id, name, kind)')
    .eq('user_id', userId);
  const owner = ((memberships ?? []) as unknown as { role: string; organisations: (Org & { kind: string }) | null }[]).find(
    (m) => m.organisations?.kind === 'owner',
  );
  if (!owner?.organisations) return { status: 'error', message: t('readiness.ownersOnly') };

  const [shelters, templates, tasks, contacts, activation, lastEnded] = await Promise.all([
    fetchAll<{ id: string; address: string }>((from, to) => supabase.from('shelters').select('id, address').order('address').range(from, to)),
    fetchTemplates(),
    fetchTasks(),
    fetchContacts(),
    fetchActiveActivation(),
    fetchLastEndedActivation(),
  ]);
  return {
    status: 'ready',
    org: { id: owner.organisations.id, name: owner.organisations.name },
    isAdmin: owner.role === 'owner_admin',
    shelters,
    templates,
    tasks,
    contacts,
    activation,
    lastEnded,
  };
}

// ---------------------------------------------------------------- contacts

function ContactForm({ orgId, contact, onSaved, onCancel }: { orgId: string; contact?: Contact; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(contact?.name ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [role, setRole] = useState(contact?.role_note ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await saveContact({ id: contact?.id ?? crypto.randomUUID(), orgId, name, phone, email, roleNote: role });
      onSaved();
    } catch (err) {
      setError(t('readiness.saveFailed', { message: (err as Error).message }));
      setBusy(false);
    }
  }

  return (
    <form class="contact-form" onSubmit={submit}>
      <label class="field">
        <span>{t('readiness.contacts.name')}</span>
        <input type="text" required minLength={2} maxLength={120} autocomplete="off" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>{t('readiness.contacts.phone')}</span>
        <input type="tel" required pattern="\+?[0-9 \(\)\-]{6,20}" maxLength={20} autocomplete="off" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>{t('readiness.contacts.email')}</span>
        <input type="email" maxLength={254} autocomplete="off" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>{t('readiness.contacts.role')}</span>
        <input type="text" maxLength={120} autocomplete="off" value={role} onInput={(e) => setRole(e.currentTarget.value)} />
      </label>
      {error && <p class="error" role="alert">{error}</p>}
      <div class="actions">
        <button type="button" class="secondary" onClick={onCancel} disabled={busy}>{t('readiness.cancel')}</button>
        <button type="submit" class="primary" disabled={busy}>{t('readiness.contacts.save')}</button>
      </div>
    </form>
  );
}

function ContactsCard({ orgId, contacts, isAdmin, onChange }: { orgId: string; contacts: Contact[]; isAdmin: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');

  async function remove(c: Contact) {
    if (!window.confirm(t('readiness.contacts.confirmDelete', { name: c.name }))) return;
    try {
      await deleteContact(c.id);
      onChange();
    } catch (err) {
      setError(t('readiness.saveFailed', { message: (err as Error).message }));
    }
  }

  return (
    <section class="card">
      <h2>{t('readiness.contacts.title')}</h2>
      <p class="muted small">{t('readiness.contacts.intro')}</p>
      {contacts.length === 0 && editing !== 'new' && <p class="muted">{t('readiness.contacts.empty')}</p>}
      <ul class="contact-list">
        {contacts.map((c) =>
          editing === c.id ? (
            <li key={c.id}>
              <ContactForm orgId={orgId} contact={c} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChange(); }} />
            </li>
          ) : (
            <li key={c.id}>
              <div class="contact-main">
                <div class="contact-name">{c.name}</div>
                <div class="contact-sub">
                  {c.role_note && <>{c.role_note} · </>}
                  <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}>{c.phone}</a>
                  {c.email && <> · <a href={`mailto:${c.email}`}>{c.email}</a></>}
                </div>
              </div>
              {isAdmin && (
                <div class="contact-actions">
                  <button type="button" class="link-button" onClick={() => setEditing(c.id)}>{t('readiness.contacts.edit')}</button>
                  <button type="button" class="link-button" onClick={() => remove(c)}>{t('readiness.contacts.delete')}</button>
                </div>
              )}
            </li>
          ),
        )}
      </ul>
      {error && <p class="error" role="alert">{error}</p>}
      {isAdmin &&
        (editing === 'new' ? (
          <ContactForm orgId={orgId} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChange(); }} />
        ) : (
          <button type="button" class="secondary block-button" onClick={() => setEditing('new')}>＋ {t('readiness.contacts.add')}</button>
        ))}
    </section>
  );
}

// -------------------------------------------------------------------- page

export function ReadinessPage({ session }: { session: Session }) {
  useLang();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [completions, setCompletions] = useState<Map<string, Completion>>(new Map());
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lastSeen = useRef<string | undefined>(undefined);
  const now = useNow(1000);

  useEffect(() => {
    let cancelled = false;
    load(session.user.id)
      .then((s) => !cancelled && setState(s))
      .catch(() => !cancelled && setState({ status: 'error', message: t('home.loadFailed') }));
    return () => {
      cancelled = true;
    };
  }, [session.user.id, reloadKey]);

  const activation = state.status === 'ready' ? state.activation : null;

  // Live progress: poll for completions changed since the last poll, while
  // the page is visible. All reads go through the same RLS as everything else.
  useEffect(() => {
    if (!activation) return;
    let stopped = false;
    lastSeen.current = undefined;
    setCompletions(new Map());

    async function poll() {
      if (document.visibilityState !== 'visible') return;
      try {
        const changed = await fetchCompletions(activation!.id, lastSeen.current);
        if (stopped || !changed.length) return;
        lastSeen.current = changed[changed.length - 1].updated_at;
        setCompletions((prev) => {
          const next = new Map(prev);
          for (const c of changed) next.set(c.task_id, c);
          return next;
        });
      } catch {
        // Offline for a moment; the next poll catches up.
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [activation?.id]);

  const derived = useMemo(() => {
    if (state.status !== 'ready') return null;
    const { tasks, shelters, templates } = state;
    const byShelter = new Map<string, ReadinessTask[]>();
    for (const task of tasks) byShelter.set(task.shelter_id, [...(byShelter.get(task.shelter_id) ?? []), task]);
    return {
      byShelter,
      withPlan: shelters.filter((s) => byShelter.has(s.id)).length,
      unassigned: tasks.filter((task) => !task.responsible_contact_id).length,
      templateById: new Map(templates.map((tp) => [tp.id, tp])),
    };
  }, [state]);

  if (state.status === 'loading') return <p class="muted">{t('home.loading')}</p>;
  if (state.status === 'error' || !derived) {
    return (
      <section class="card narrow">
        <p class="error" role="alert">{state.status === 'error' ? state.message : ''}</p>
        <a class="button secondary" href={href()}>{t('receipt.back')}</a>
      </section>
    );
  }

  const { org, isAdmin, shelters, templates, tasks, contacts, lastEnded } = state;
  const isDone = (taskId: string) => completions.get(taskId)?.done === true;

  async function run(action: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await action();
      if (typeof result === 'number') setMessage(t('readiness.created', { count: result }));
      setReloadKey((k) => k + 1);
      window.dispatchEvent(new Event(READINESS_CHANGED));
    } catch (err) {
      setMessage(t('readiness.simulation.failed', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  // Progress while a simulation runs.
  const doneCount = activation ? tasks.filter((task) => isDone(task.id)).length : 0;
  const perTemplate = activation
    ? templates.map((tp) => {
        const these = tasks.filter((task) => task.template_id === tp.id);
        const done = these.filter((task) => isDone(task.id)).length;
        const due = taskDeadline(activation, tp.target_hour);
        return { tp, total: these.length, done, due, overdue: now > due.getTime() && done < these.length };
      })
    : [];
  const perShelter = activation
    ? shelters
        .filter((s) => derived.byShelter.has(s.id))
        .map((s) => {
          const these = derived.byShelter.get(s.id)!;
          const done = these.filter((task) => isDone(task.id)).length;
          const overdue = these.filter((task) => !isDone(task.id) && now > taskDeadline(activation, task.target_hour).getTime()).length;
          return { shelter: s, total: these.length, done, overdue };
        })
        .sort((a, b) => b.overdue - a.overdue || a.done / a.total - b.done / b.total || a.shelter.address.localeCompare(b.shelter.address, 'sv'))
    : [];

  return (
    <div class="stack">
      <a class="link-button back-link" href={href()}>← {t('receipt.back')}</a>

      <section class="card">
        <div class="eyebrow">{org.name}</div>
        <h1>{t('readiness.title')}</h1>
        <p class="muted">{t('readiness.intro')}</p>
        {templates.some((tp) => tp.is_placeholder) && <p class="notice">{t('readiness.templateNote')}</p>}
        <p class="stat">{t('readiness.coverage', { withPlan: formatNumber(derived.withPlan), total: formatNumber(shelters.length) })}</p>
        {tasks.length > 0 && (
          <p class="muted small">
            {derived.unassigned ? t('readiness.unassigned', { count: formatNumber(derived.unassigned) }) : t('readiness.allAssigned')}
          </p>
        )}
        {isAdmin && derived.withPlan < shelters.length && (
          <div class="actions">
            <button type="button" class="secondary" disabled={busy} onClick={() => run(() => setupPlans(org.id))}>
              {busy ? t('readiness.settingUp') : t('readiness.setupAll')}
            </button>
          </div>
        )}
        {message && <p class="notice" role="status">{message}</p>}
      </section>

      {activation ? (
        <section class="card simulation" aria-live="polite">
          <div class="sim-badge">{t('readiness.simulation.badge')}</div>
          <p class="sim-running">{t('readiness.simulation.running')}</p>
          <div class="sim-clock">
            <div class="eyebrow">
              {now > new Date(activation.deadline_at).getTime() ? t('readiness.simulation.overtime') : t('readiness.simulation.timeLeft')}
            </div>
            <Countdown deadline={activation.deadline_at} class="countdown big" />
            <div class="muted small">
              {t('readiness.simulation.startedBy', { time: formatDateTime(activation.started_at) })} ·{' '}
              {t('readiness.simulation.deadline', { time: formatDateTime(activation.deadline_at) })}
            </div>
          </div>

          <p class="stat">
            {t('readiness.simulation.progress', { done: formatNumber(doneCount), total: formatNumber(tasks.length), percent: percent(doneCount, tasks.length) })}
          </p>
          <ProgressBar value={percent(doneCount, tasks.length)} label={t('readiness.simulation.byTask')} />
          <p class="saved-hint">{t('readiness.simulation.updated')}</p>

          <h2 class="section-title">{t('readiness.simulation.byTask')}</h2>
          <ul class="progress-list">
            {perTemplate.map(({ tp, total, done, due, overdue }) => (
              <li key={tp.id} class={overdue ? 'overdue' : ''}>
                <div class="progress-head">
                  <span class="progress-title">{localized(tp, 'title')}</span>
                  <span class="progress-count">{done}/{total}</span>
                </div>
                <ProgressBar value={percent(done, total)} label={localized(tp, 'title')} />
                <div class="progress-sub">
                  {t('readiness.dueAt', { time: formatDateTime(due.toISOString()) })}
                  {overdue && <strong> · ⚠ {t('readiness.simulation.overdue')}</strong>}
                </div>
              </li>
            ))}
          </ul>

          <h2 class="section-title">{t('readiness.simulation.byShelter')}</h2>
          <ul class="progress-list compact">
            {perShelter.map(({ shelter, total, done, overdue }) => (
              <li key={shelter.id} class={overdue ? 'overdue' : ''}>
                <a href={href('skyddsrum', shelter.id)}>
                  <div class="progress-head">
                    <span class="progress-title">{shelter.address || shelter.id}</span>
                    <span class="progress-count">
                      {overdue > 0 && <>⚠ {t('readiness.simulation.overdueCount', { count: overdue })} · </>}
                      {done}/{total}
                    </span>
                  </div>
                  <ProgressBar value={percent(done, total)} label={shelter.address} />
                </a>
              </li>
            ))}
          </ul>

          {isAdmin && (
            <div class="actions">
              <button type="button" class="secondary" disabled={busy} onClick={() => run(() => endSimulation(activation.id), t('readiness.simulation.confirmEnd'))}>
                {t('readiness.simulation.end')}
              </button>
            </div>
          )}
        </section>
      ) : (
        <section class="card">
          <h2>{t('readiness.simulation.title')}</h2>
          <p class="muted">{t('readiness.simulation.explain')}</p>
          {lastEnded?.ended_at && <p class="muted small">{t('readiness.simulation.lastRun', { time: formatDateTime(lastEnded.ended_at) })}</p>}
          {isAdmin && (
            <button
              type="button"
              class="primary block-button"
              disabled={busy || tasks.length === 0}
              onClick={() => run(() => startSimulation(org.id), t('readiness.simulation.confirmStart'))}
            >
              {busy ? t('readiness.simulation.starting') : t('readiness.simulation.start')}
            </button>
          )}
        </section>
      )}

      <ContactsCard orgId={org.id} contacts={contacts} isAdmin={isAdmin} onChange={() => setReloadKey((k) => k + 1)} />
    </div>
  );
}
