import { supabase } from './supabase';
import { fetchAll } from './readiness';
import type { ReviewStatus } from './status';

export interface StatusRow {
  shelter_id: string;
  address: string;
  capacity: number;
  kommun_kod: string;
  kommun: string;
  lan_kod: string;
  lon: number;
  lat: number;
  owner_org_id: string | null;
  owner_name: string | null;
  order_id: string | null;
  notice_id: string | null;
  due_date: string | null;
  issued_at: string | null;
  self_check_id: string | null;
  submitted_at: string | null;
  brist_count: number | null;
  review_outcome: string | null;
  reviewed_at: string | null;
  status: ReviewStatus;
}

const FIELDS =
  'shelter_id, address, capacity, kommun_kod, kommun, lan_kod, lon, lat, owner_org_id, owner_name, order_id, notice_id, due_date, issued_at, self_check_id, submitted_at, brist_count, review_outcome, reviewed_at, status';

/** Every shelter the caller may see, with its review status (RLS decides which). */
export function fetchStatusRows(): Promise<StatusRow[]> {
  return fetchAll<StatusRow>((from, to) => supabase.from('shelter_review_status').select(FIELDS).order('shelter_id').range(from, to));
}

export async function fetchStatusRowsFor(ids: string[]): Promise<StatusRow[]> {
  const out: StatusRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('shelter_review_status').select(FIELDS).in('shelter_id', ids.slice(i, i + 100));
    if (error) throw error;
    out.push(...((data ?? []) as StatusRow[]));
  }
  return out;
}

/**
 * Shelters whose status may have changed since `since`: new submissions,
 * reviews, orders and cancellations. Cheap queries, polled every few seconds.
 */
export async function changedShelterIds(since: string): Promise<{ ids: string[]; latest: string }> {
  const [checks, reviews, issued, cancelled] = await Promise.all([
    supabase.from('self_checks').select('shelter_id, submitted_at').gt('submitted_at', since).limit(1000),
    supabase.from('self_check_reviews').select('shelter_id, reviewed_at').gt('reviewed_at', since).limit(1000),
    supabase.from('orders').select('shelter_id, issued_at').gt('issued_at', since).limit(1000),
    supabase.from('orders').select('shelter_id, cancelled_at').gt('cancelled_at', since).limit(1000),
  ]);
  const ids = new Set<string>();
  let latest = since;
  const take = (rows: Record<string, string>[] | null, field: string) => {
    for (const r of rows ?? []) {
      ids.add(r.shelter_id);
      if (r[field] > latest) latest = r[field];
    }
  };
  take(checks.data, 'submitted_at');
  take(reviews.data, 'reviewed_at');
  take(issued.data, 'issued_at');
  take(cancelled.data, 'cancelled_at');
  return { ids: [...ids], latest };
}

export interface OrderNoticeSummary {
  notice_id: string;
  token: string;
  owner_org_id: string;
  owner_name: string;
  shelters: number;
}

export interface CreateOrdersResult {
  batch_id: string;
  due_date: string;
  requested: number;
  created: number;
  outside_lan: number;
  no_owner: number;
  already_open: number;
  notices: OrderNoticeSummary[];
}

export async function createOrders(lstOrgId: string, shelterIds: string[], dueDate: string): Promise<CreateOrdersResult> {
  const { data, error } = await supabase.rpc('create_orders', { p_lst_org_id: lstOrgId, p_shelter_ids: shelterIds, p_due_date: dueDate });
  if (error) throw error;
  return data as CreateOrdersResult;
}

export async function cancelOrder(orderId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_order', { p_order_id: orderId });
  if (error) throw error;
}

export async function reviewSelfCheck(checkId: string, items: { item_id: string; decision: string; comment: string }[], comment: string) {
  const { data, error } = await supabase.rpc('review_self_check', { p_self_check_id: checkId, p_items: items, p_comment: comment });
  if (error) throw error;
  return data as { id: string; outcome: string };
}

/** The link the länsstyrelse hands to an owner. Opening it still requires signing in. */
export function noticeLink(token: string): string {
  return `${location.origin}${location.pathname}#/forelaggande/${token}`;
}
