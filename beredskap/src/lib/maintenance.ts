import { supabase } from './supabase';
import { t } from '../i18n';
import { formatDateTime } from './format';
import { toCsv } from './csv';
import type { MaintenanceDraft } from './drafts';

export const CATEGORIES = [
  'inspektion',
  'reparation',
  'ventilation',
  'dorrar',
  'utrustning',
  'rensning',
  'skyltning',
  'ovrigt',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface MaintenanceEntry {
  id: string;
  shelter_id: string;
  performed_on: string;
  category: Category;
  description: string;
  performed_by: string;
  registered_by: string;
  created_at: string;
  maintenance_voids: { reason: string; voided_at: string } | null;
}

export interface EntryPhoto {
  id: string;
  context_id: string;
  storage_path: string;
}

const ENTRY_FIELDS = 'id, shelter_id, performed_on, category, description, performed_by, registered_by, created_at, maintenance_voids(reason, voided_at)';

/** Today in Swedish time as YYYY-MM-DD (the value an <input type="date"> uses). */
export function todayInSweden(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
}

export function categoryLabel(c: string): string {
  return t(`maintenance.category.${c}`);
}

export async function fetchLog(shelterId: string): Promise<{ entries: MaintenanceEntry[]; photos: EntryPhoto[] }> {
  const [entries, photos] = await Promise.all([
    supabase
      .from('maintenance_entries')
      .select(ENTRY_FIELDS)
      .eq('shelter_id', shelterId)
      .order('performed_on', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('photos')
      .select('id, context_id, storage_path')
      .eq('context', 'maintenance')
      .eq('shelter_id', shelterId)
      .order('created_at'),
  ]);
  if (entries.error) throw entries.error;
  return { entries: (entries.data ?? []) as unknown as MaintenanceEntry[], photos: (photos.data ?? []) as EntryPhoto[] };
}

export async function addEntry(draft: MaintenanceDraft): Promise<MaintenanceEntry> {
  const { data, error } = await supabase.rpc('add_maintenance_entry', {
    p_id: draft.id,
    p_shelter_id: draft.shelterId,
    p_performed_on: draft.performedOn,
    p_category: draft.category,
    p_description: draft.description,
    p_performed_by: draft.performedBy,
  });
  if (error) throw error;
  return data as MaintenanceEntry;
}

export async function voidEntry(entryId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_maintenance_entry', { p_entry_id: entryId, p_reason: reason });
  if (error) throw error;
}

/** Names of colleagues, for "registered by". Others' names are not readable, by design. */
export async function profileNames(userIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return {};
  const { data } = await supabase.from('profiles').select('user_id, full_name').in('user_id', ids);
  return Object.fromEntries((data ?? []).map((p) => [p.user_id, p.full_name]));
}

type CsvEntry = MaintenanceEntry & { shelters?: { address: string; kommuner: { namn: string } | null } | null };

/** CSV rows, oldest first, with registration time and voids so the export is honest. */
export function logToCsv(entries: CsvEntry[], photoCounts: Record<string, number>, names: Record<string, string>): string {
  const sorted = [...entries].sort((a, b) => a.performed_on.localeCompare(b.performed_on) || a.created_at.localeCompare(b.created_at));
  return toCsv([
    [
      t('maintenance.csv.shelter'),
      t('maintenance.csv.address'),
      t('maintenance.csv.kommun'),
      t('maintenance.csv.performedOn'),
      t('maintenance.csv.category'),
      t('maintenance.csv.description'),
      t('maintenance.csv.performedBy'),
      t('maintenance.csv.registered'),
      t('maintenance.csv.registeredBy'),
      t('maintenance.csv.photos'),
      t('maintenance.csv.status'),
      t('maintenance.csv.voidReason'),
      t('maintenance.csv.id'),
    ],
    ...sorted.map((e) => [
      e.shelter_id,
      e.shelters?.address ?? '',
      e.shelters?.kommuner?.namn ?? '',
      e.performed_on,
      categoryLabel(e.category),
      e.description,
      e.performed_by,
      formatDateTime(e.created_at),
      names[e.registered_by] ?? '',
      photoCounts[e.id] ?? 0,
      e.maintenance_voids ? t('maintenance.voided') : t('maintenance.active'),
      e.maintenance_voids?.reason ?? '',
      e.id,
    ]),
  ]);
}

/** Every entry the organisation can read, across all its shelters (for the org-wide CSV). */
export async function fetchOrgLog(): Promise<{ entries: CsvEntry[]; photoCounts: Record<string, number> }> {
  const entries: CsvEntry[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('maintenance_entries')
      .select(`${ENTRY_FIELDS}, shelters(address, kommuner(namn))`)
      .order('performed_on')
      .range(from, from + 999);
    if (error) throw error;
    entries.push(...((data ?? []) as unknown as CsvEntry[]));
    if ((data ?? []).length < 1000) break;
  }
  const photoCounts: Record<string, number> = {};
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('photos').select('context_id').eq('context', 'maintenance').range(from, from + 999);
    for (const p of data ?? []) photoCounts[p.context_id] = (photoCounts[p.context_id] ?? 0) + 1;
    if ((data ?? []).length < 1000) break;
  }
  return { entries, photoCounts };
}
