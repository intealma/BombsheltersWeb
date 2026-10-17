import { useEffect, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { t, useLang } from '../i18n';
import { localized } from '../lib/checklist';
import { formatDateTime } from '../lib/format';
import { href } from '../lib/router';
import {
  assignTask,
  fetchActiveActivation,
  fetchCompletions,
  fetchContacts,
  fetchTasks,
  fetchTemplates,
  setTaskDone,
  setupPlans,
  taskDeadline,
  type Activation,
  type Completion,
  type Contact,
  type ReadinessTask,
  type TaskTemplate,
} from '../lib/readiness';
import { Countdown, useNow } from '../components/countdown';

const POLL_MS = 5000;

function ContactLink({ contact }: { contact: Contact | undefined }) {
  if (!contact) return <span class="muted">{t('readiness.nobody')}</span>;
  return (
    <>
      {contact.name}{' '}
      <a href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`} aria-label={t('readiness.call', { name: contact.name })}>
        {contact.phone}
      </a>
    </>
  );
}

function AssignForm({ task, contacts, onSaved, onCancel }: { task: ReadinessTask; contacts: Contact[]; onSaved: () => void; onCancel: () => void }) {
  const [responsible, setResponsible] = useState(task.responsible_contact_id ?? '');
  const [backup, setBackup] = useState(task.backup_contact_id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    try {
      await assignTask(task.id, responsible || null, backup || null);
      onSaved();
    } catch (err) {
      setError(t('readiness.saveFailed', { message: (err as Error).message }));
      setBusy(false);
    }
  }

  const options = (exclude: string) =>
    contacts.filter((c) => c.id !== exclude).map((c) => <option key={c.id} value={c.id}>{c.name}{c.role_note ? ` (${c.role_note})` : ''}</option>);

  return (
    <form class="assign-form" onSubmit={submit}>
      <label class="field">
        <span>{t('readiness.responsible')}</span>
        <select value={responsible} onChange={(e) => setResponsible(e.currentTarget.value)}>
          <option value="">{t('readiness.nobody')}</option>
          {options(backup)}
        </select>
      </label>
      <label class="field">
        <span>{t('readiness.backup')}</span>
        <select value={backup} onChange={(e) => setBackup(e.currentTarget.value)}>
          <option value="">{t('readiness.nobody')}</option>
          {options(responsible)}
        </select>
      </label>
      {error && <p class="error" role="alert">{error}</p>}
      <div class="actions">
        <button type="button" class="secondary" onClick={onCancel} disabled={busy}>{t('readiness.cancel')}</button>
        <button type="submit" class="primary" disabled={busy}>{t('readiness.save')}</button>
      </div>
    </form>
  );
}

interface Data {
  orgId: string;
  isAdmin: boolean;
  tasks: ReadinessTask[];
  templates: Map<string, TaskTemplate>;
  contacts: Map<string, Contact>;
  contactList: Contact[];
  activation: Activation | null;
}

/** The 48-hour plan for one shelter. Only rendered for the owner organisation. */
export function ShelterPlan({ shelterId, session }: { shelterId: string; session: Session }) {
  useLang();
  const [data, setData] = useState<Data | null>(null);
  const [completions, setCompletions] = useState<Map<string, Completion>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const now = useNow(1000);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: memberships } = await supabase
        .from('memberships')
        .select('role, organisations(id, kind)')
        .eq('user_id', session.user.id);
      const owner = ((memberships ?? []) as unknown as { role: string; organisations: { id: string; kind: string } | null }[]).find(
        (m) => m.organisations?.kind === 'owner',
      );
      if (!owner?.organisations) return;
      const [tasks, templates, contacts, activation] = await Promise.all([
        fetchTasks(shelterId),
        fetchTemplates(),
        fetchContacts(),
        fetchActiveActivation(),
      ]);
      if (cancelled) return;
      setData({
        orgId: owner.organisations.id,
        isAdmin: owner.role === 'owner_admin',
        tasks,
        templates: new Map(templates.map((tp) => [tp.id, tp])),
        contacts: new Map(contacts.map((c) => [c.id, c])),
        contactList: contacts,
        activation,
      });
    })().catch(() => !cancelled && setError(t('home.loadFailed')));
    return () => {
      cancelled = true;
    };
  }, [shelterId, session.user.id, reloadKey]);

  // Poll so ticks made on another phone show up here too.
  const activationId = data?.activation?.id;
  useEffect(() => {
    if (!activationId) return;
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      const all = await fetchCompletions(activationId).catch(() => null);
      if (!stopped && all) setCompletions(new Map(all.filter((c) => c.shelter_id === shelterId).map((c) => [c.task_id, c])));
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [activationId, shelterId]);

  if (!data) return error ? <section class="card"><p class="error">{error}</p></section> : null;
  const { orgId, isAdmin, tasks, templates, contacts, contactList, activation } = data;

  async function toggle(task: ReadinessTask) {
    if (!activation) return;
    const done = completions.get(task.id)?.done !== true;
    setBusy(task.id);
    setError('');
    try {
      const c = await setTaskDone(activation.id, task.id, done);
      setCompletions((prev) => new Map(prev).set(task.id, c));
    } catch (err) {
      setError(t('readiness.simulation.failed', { message: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  async function createPlan() {
    setBusy('setup');
    try {
      await setupPlans(orgId, shelterId);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(t('readiness.saveFailed', { message: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section class={`card${activation ? ' simulation' : ''}`}>
      <div class="card-head">
        <h2>{t('readiness.title')}</h2>
        <a class="link-button" href={href('beredskap')}>{t('readiness.open')} →</a>
      </div>

      {activation && (
        <div class="sim-inline">
          <span class="sim-badge">{t('readiness.simulation.badge')}</span>
          <Countdown deadline={activation.deadline_at} class="countdown" />
        </div>
      )}

      {tasks.length === 0 ? (
        <>
          <p class="muted">{isAdmin ? t('readiness.noPlan') : t('readiness.noPlanCaretaker')}</p>
          {isAdmin && (
            <button type="button" class="secondary block-button" onClick={createPlan} disabled={busy === 'setup'}>
              {busy === 'setup' ? t('readiness.settingUp') : t('readiness.setupOne')}
            </button>
          )}
        </>
      ) : (
        <ul class="task-list">
          {tasks.map((task) => {
            const c = completions.get(task.id);
            const done = c?.done === true;
            const due = activation ? taskDeadline(activation, task.target_hour) : null;
            const overdue = Boolean(due && !done && now > due.getTime());
            const tp = templates.get(task.template_id);
            return (
              <li key={task.id} class={`${done ? 'done' : ''}${overdue ? ' overdue' : ''}`}>
                <div class="task-head">
                  <span class="task-title">{task.position}. {localized(task, 'title')}</span>
                  <span class="task-due">
                    {due ? t('readiness.dueAt', { time: formatDateTime(due.toISOString()) }) : t('readiness.byHour', { hour: task.target_hour })}
                    {overdue && <strong> · ⚠ {t('readiness.simulation.overdue')}</strong>}
                  </span>
                </div>
                {tp && localized(tp, 'help') && <p class="task-help">{localized(tp, 'help')}</p>}
                <dl class="task-people">
                  <dt>{t('readiness.responsible')}</dt>
                  <dd><ContactLink contact={task.responsible_contact_id ? contacts.get(task.responsible_contact_id) : undefined} /></dd>
                  <dt>{t('readiness.backup')}</dt>
                  <dd><ContactLink contact={task.backup_contact_id ? contacts.get(task.backup_contact_id) : undefined} /></dd>
                </dl>

                {activation && (
                  <button
                    type="button"
                    class={`task-toggle${done ? ' is-done' : ''}`}
                    aria-pressed={done}
                    disabled={busy === task.id}
                    onClick={() => toggle(task)}
                  >
                    <span class="task-box" aria-hidden="true">{done ? '✓' : ''}</span>
                    <span>
                      {done ? t('readiness.simulation.doneAt', { time: formatDateTime(c!.done_at!) }) : t('readiness.simulation.markDone')}
                      {done && <span class="task-undo"> · {t('readiness.simulation.markNotDone')}</span>}
                    </span>
                  </button>
                )}

                {isAdmin && !activation && (
                  editing === task.id ? (
                    <AssignForm
                      task={task}
                      contacts={contactList}
                      onCancel={() => setEditing(null)}
                      onSaved={() => {
                        setEditing(null);
                        setReloadKey((k) => k + 1);
                      }}
                    />
                  ) : (
                    <button type="button" class="link-button" onClick={() => setEditing(task.id)}>{t('readiness.assign')}</button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}
