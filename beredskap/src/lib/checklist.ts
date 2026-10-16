import { supabase } from './supabase';
import { getLang } from '../i18n';
import type { Draft, Status } from './drafts';

export interface ChecklistItem {
  id: string;
  key: string;
  position: number;
  title_sv: string;
  title_en: string;
  help_sv: string;
  help_en: string;
  photo_required_on_brist: boolean;
}

export interface Template {
  id: string;
  key: string;
  version: number;
  title_sv: string;
  title_en: string;
  description_sv: string;
  description_en: string;
  is_placeholder: boolean;
  items: ChecklistItem[];
}

export interface SelfCheckRow {
  id: string;
  shelter_id: string;
  inspector_name: string;
  submitted_at: string;
  ok_count: number;
  brist_count: number;
  na_count: number;
}

/** Picks the Swedish or English variant of a field, e.g. title_sv / title_en. */
export function localized<T extends object>(obj: T, field: string): string {
  const record = obj as Record<string, unknown>;
  const value = record[`${field}_${getLang()}`] ?? record[`${field}_sv`];
  return typeof value === 'string' ? value : '';
}

export async function fetchActiveTemplate(): Promise<Template> {
  const { data, error } = await supabase
    .from('checklist_templates')
    .select('id, key, version, title_sv, title_en, description_sv, description_en, is_placeholder, checklist_items(*)')
    .eq('key', 'forenklad-kontroll')
    .eq('active', true)
    .single();
  if (error) throw error;
  const { checklist_items, ...template } = data as Omit<Template, 'items'> & { checklist_items: ChecklistItem[] };
  return { ...template, items: [...checklist_items].sort((a, b) => a.position - b.position) };
}

export function photoRequired(item: ChecklistItem, status: Status | undefined): boolean {
  return status === 'brist' && item.photo_required_on_brist;
}

export async function submitSelfCheck(draft: Draft): Promise<SelfCheckRow> {
  const { data, error } = await supabase.rpc('submit_self_check', {
    p_id: draft.id,
    p_shelter_id: draft.shelterId,
    p_template_id: draft.template.id,
    p_inspector_name: draft.inspectorName,
    p_started_at: draft.startedAt,
    p_answers: draft.template.items.map((item) => ({
      item_id: item.id,
      status: draft.answers[item.id]?.status,
      comment: draft.answers[item.id]?.comment ?? '',
    })),
  });
  if (error) throw error;
  return data as SelfCheckRow;
}
