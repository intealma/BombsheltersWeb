import { supabase } from './supabase';

export interface TaskTemplate {
  id: string;
  key: string;
  position: number;
  title_sv: string;
  title_en: string;
  help_sv: string;
  help_en: string;
  target_hour: number;
  is_placeholder: boolean;
}

export interface ReadinessTask {
  id: string;
  shelter_id: string;
  template_id: string;
  position: number;
  title_sv: string;
  title_en: string;
  target_hour: number;
  responsible_contact_id: string | null;
  backup_contact_id: string | null;
}

export interface Contact {
  id: string;
  owner_org_id: string;
  name: string;
  phone: string;
  email: string | null;
  role_note: string;
}

export interface Activation {
  id: string;
  owner_org_id: string;
  is_simulation: boolean;
  started_at: string;
  started_by: string;
  deadline_at: string;
  ended_at: string | null;
  ended_by: string | null;
}

export interface Completion {
  activation_id: string;
  task_id: string;
  shelter_id: string;
  done: boolean;
  done_at: string | null;
  done_by: string | null;
  updated_at: string;
}

/** PostgREST returns at most 1000 rows per request, so page through. */
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export async function fetchTemplates(): Promise<TaskTemplate[]> {
  const { data, error } = await supabase.from('readiness_task_templates').select('*').eq('active', true).order('position');
  if (error) throw error;
  return (data ?? []) as TaskTemplate[];
}

export function fetchTasks(shelterId?: string): Promise<ReadinessTask[]> {
  return fetchAll<ReadinessTask>((from, to) => {
    let q = supabase
      .from('readiness_tasks')
      .select('id, shelter_id, template_id, position, title_sv, title_en, target_hour, responsible_contact_id, backup_contact_id')
      .order('shelter_id')
      .order('position')
      .range(from, to);
    if (shelterId) q = q.eq('shelter_id', shelterId);
    return q;
  });
}

export async function fetchContacts(): Promise<Contact[]> {
  const { data, error } = await supabase.from('org_contacts').select('id, owner_org_id, name, phone, email, role_note').order('name');
  if (error) throw error;
  return (data ?? []) as Contact[];
}

/** The running simulation for the caller's organisation, if any. */
export async function fetchActiveActivation(): Promise<Activation | null> {
  const { data } = await supabase.from('readiness_activations').select('*').is('ended_at', null).maybeSingle();
  return (data as Activation | null) ?? null;
}

export async function fetchLastEndedActivation(): Promise<Activation | null> {
  const { data } = await supabase
    .from('readiness_activations')
    .select('*')
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Activation | null) ?? null;
}

/** Completions changed since `since` (or all of them). Used for polling. */
export function fetchCompletions(activationId: string, since?: string): Promise<Completion[]> {
  return fetchAll<Completion>((from, to) => {
    let q = supabase
      .from('readiness_task_completions')
      .select('activation_id, task_id, shelter_id, done, done_at, done_by, updated_at')
      .eq('activation_id', activationId)
      .order('updated_at')
      .range(from, to);
    if (since) q = q.gt('updated_at', since);
    return q;
  });
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const setupPlans = (orgId: string, shelterId?: string) =>
  rpc<number>('setup_readiness_plans', { p_org_id: orgId, p_shelter_id: shelterId ?? null });

export const saveContact = (c: { id: string; orgId: string; name: string; phone: string; email: string; roleNote: string }) =>
  rpc<Contact>('save_contact', { p_id: c.id, p_org_id: c.orgId, p_name: c.name, p_phone: c.phone, p_email: c.email || null, p_role_note: c.roleNote });

export const deleteContact = (id: string) => rpc<void>('delete_contact', { p_id: id });

export const assignTask = (taskId: string, responsible: string | null, backup: string | null) =>
  rpc<ReadinessTask>('assign_readiness_task', { p_task_id: taskId, p_responsible: responsible, p_backup: backup });

export const startSimulation = (orgId: string) => rpc<Activation>('start_readiness_simulation', { p_org_id: orgId });

export const endSimulation = (activationId: string) => rpc<Activation>('end_readiness_simulation', { p_activation_id: activationId });

export const setTaskDone = (activationId: string, taskId: string, done: boolean) =>
  rpc<Completion>('set_readiness_task_done', { p_activation_id: activationId, p_task_id: taskId, p_done: done });

/** When a task is due in a given activation. */
export function taskDeadline(activation: Activation, targetHour: number): Date {
  return new Date(new Date(activation.started_at).getTime() + targetHour * 3_600_000);
}

/** "47:12:05". Negative durations are shown as overtime with a leading "+". */
export function formatCountdown(ms: number): string {
  const over = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${over ? '+' : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function percent(done: number, total: number): number {
  return total ? Math.round((done / total) * 100) : 0;
}
