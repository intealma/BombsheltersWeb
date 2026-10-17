// Milestone 5: orders (förelägganden), links per owner, review of
// submissions and the status every shelter shows on the dashboard.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { admin, ALL_CALLERS, createFixtures, rows, signInAll, type Caller, type Fixtures } from './helpers';

let fx: Fixtures;
let as: Record<Caller, SupabaseClient>;
let template: { id: string; items: { id: string }[] };

beforeAll(async () => {
  fx = await createFixtures();
  as = await signInAll(fx);
  const { data } = await admin.from('checklist_templates').select('id, checklist_items(id)').eq('active', true).single();
  template = { id: data!.id, items: data!.checklist_items as { id: string }[] };
});

afterAll(async () => {
  await fx?.cleanup();
});

/** YYYY-MM-DD in Swedish time, `days` from today. */
function day(days: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date(Date.now() + days * 86_400_000));
}

const allTestShelters = () => [fx.shelters.A1, fx.shelters.A2, fx.shelters.B1, fx.shelters.U1, fx.shelters.J1];

function order(caller: Caller, shelterIds: string[], due = day(30), lstOrg = fx.orgs.lst05) {
  return as[caller].rpc('create_orders', { p_lst_org_id: lstOrg, p_shelter_ids: shelterIds, p_due_date: due });
}

async function submitCheck(caller: Caller, shelterId: string) {
  const { data, error } = await as[caller].rpc('submit_self_check', {
    p_id: randomUUID(),
    p_shelter_id: shelterId,
    p_template_id: template.id,
    p_inspector_name: 'Test Inspektör',
    p_started_at: new Date().toISOString(),
    p_answers: template.items.map((i) => ({ item_id: i.id, status: 'ok', comment: '' })),
  });
  if (error) throw error;
  return data as { id: string };
}

async function status(caller: Caller) {
  const data = await rows<{ shelter_id: string; status: string }>(
    as[caller].from('shelter_review_status').select('shelter_id, status').in('shelter_id', allTestShelters()),
  );
  const key = (id: string) => (Object.keys(fx.shelters) as (keyof Fixtures['shelters'])[]).find((k) => fx.shelters[k] === id);
  return Object.fromEntries(data.map((r) => [key(r.shelter_id), r.status]));
}

function decisions(checkId: string, decide: (index: number) => string) {
  return admin
    .from('self_check_answers')
    .select('item_id, position')
    .eq('self_check_id', checkId)
    .order('position')
    .then(({ data }) => data!.map((a, i) => ({ item_id: a.item_id, decision: decide(i), comment: '' })));
}

describe('issuing orders', () => {
  let tokens: string[] = [];

  it('a länsstyrelse bulk-orders its shelters and gets one link per owner', async () => {
    const { data, error } = await order('lst05', allTestShelters());
    expect(error).toBeNull();
    expect(data).toMatchObject({ requested: 5, created: 3, no_owner: 1, outside_lan: 1, already_open: 0 });
    const notices = data.notices as { owner_org_id: string; token: string; shelters: number }[];
    expect(notices).toHaveLength(2);
    const byOwner = Object.fromEntries(notices.map((n) => [n.owner_org_id, n]));
    expect(byOwner[fx.orgs.ownerA].shelters).toBe(2);
    expect(byOwner[fx.orgs.ownerB].shelters).toBe(1);
    tokens = notices.map((n) => n.token);
    expect(tokens.every((tk) => /^[A-Za-z0-9_-]{24}$/.test(tk))).toBe(true);
    expect(new Set(tokens).size).toBe(2);
  });

  it('only the issuing länsstyrelse and the owners concerned can read the orders', async () => {
    const expected: Record<Caller, number> = {
      lst05: 3, ownerAdminA: 2, caretakerA: 2, ownerAdminB: 1,
      lst06: 0, kommun0580: 0, kommun0581: 0, noOrg: 0, anon: 0,
    };
    for (const caller of ALL_CALLERS) {
      const seen = await rows(as[caller].from('orders').select('id').in('shelter_id', allTestShelters()));
      expect(seen.length, caller).toBe(expected[caller]);
    }
  });

  it('ordering again skips shelters that already have an open order', async () => {
    const { data } = await order('lst05', allTestShelters());
    expect(data).toMatchObject({ created: 0, already_open: 3, notices: [] });
  });

  it.each([
    ['today', 0],
    ['in the past', -3],
    ['more than a year ahead', 400],
  ])('rejects a due date %s', async (_label, days) => {
    expect((await order('lst05', [fx.shelters.U1], day(days))).error?.message).toMatch(/due date/);
  });

  it('rejects an empty selection', async () => {
    expect((await order('lst05', [])).error?.message).toMatch(/between 1 and 5000/);
  });

  it.each(['ownerAdminA', 'caretakerA', 'kommun0580', 'noOrg', 'anon', 'lst06'] as const)(
    '%s cannot issue orders in the name of Länsstyrelsen 05',
    async (caller) => {
      expect((await order(caller, [fx.shelters.A1])).error).not.toBeNull();
    },
  );

  it('another län’s länsstyrelse cannot order shelters outside its län', async () => {
    const { data } = await order('lst06', [fx.shelters.A1, fx.shelters.B1], day(30), fx.orgs.lst06);
    expect(data).toMatchObject({ created: 0, outside_lan: 2 });
  });

  it('the owner reads its notice by the link token; nobody else can', async () => {
    const { data: notices } = await admin.from('order_notices').select('token, owner_org_id').in('token', tokens);
    const aToken = notices!.find((n) => n.owner_org_id === fx.orgs.ownerA)!.token;
    for (const caller of ALL_CALLERS) {
      const seen = await rows<{ lst_name: string; orders: unknown[] }>(
        as[caller].from('order_notices').select('lst_name, orders(shelter_id)').eq('token', aToken),
      );
      const allowed = ['ownerAdminA', 'caretakerA', 'lst05'].includes(caller);
      expect(seen.length, caller).toBe(allowed ? 1 : 0);
      if (allowed) {
        expect(seen[0].orders).toHaveLength(2);
        expect(seen[0].lst_name).toBe(`Test LST 05 ${fx.run}`);
      }
    }
  });
});

describe('status per shelter', () => {
  it('shows Förelagd for ordered shelters and Ej förelagd for the rest', async () => {
    expect(await status('lst05')).toEqual({ A1: 'forelagd', A2: 'forelagd', B1: 'forelagd', U1: 'ej_forelagd' });
  });

  it('owners see only their own shelters; another län sees only its own; kommuner see nothing', async () => {
    expect(await status('ownerAdminA')).toEqual({ A1: 'forelagd', A2: 'forelagd' });
    expect(await status('ownerAdminB')).toEqual({ B1: 'forelagd' });
    expect(await status('lst06')).toEqual({ J1: 'ej_forelagd' });
    expect(await status('kommun0580')).toEqual({});
    expect(await status('noOrg')).toEqual({});
    expect(await status('anon')).toEqual({});
  });

  it('turns into Försenad when the due date has passed', async () => {
    await admin.from('orders').update({ due_date: day(-1) }).eq('shelter_id', fx.shelters.A2).is('self_check_id', null);
    expect((await status('lst05')).A2).toBe('forsenad');
  });

  it('a submitted self-check answers the order and shows Inskickad', async () => {
    const check = await submitCheck('caretakerA', fx.shelters.A1);
    const { data: o } = await admin.from('orders').select('self_check_id, answered_at').eq('shelter_id', fx.shelters.A1).single();
    expect(o!.self_check_id).toBe(check.id);
    expect(o!.answered_at).not.toBeNull();
    expect((await status('lst05')).A1).toBe('inskickad');
    expect((await status('ownerAdminA')).A1).toBe('inskickad');
  });
});

describe('reviewing a submission', () => {
  let checkId: string;

  beforeAll(async () => {
    const { data } = await admin.from('self_checks').select('id').eq('shelter_id', fx.shelters.A1).single();
    checkId = data!.id;
  });

  it.each(['lst06', 'ownerAdminA', 'caretakerA', 'kommun0580', 'noOrg', 'anon'] as const)('%s cannot review it', async (caller) => {
    const items = await decisions(checkId, () => 'godkand');
    expect((await as[caller].rpc('review_self_check', { p_self_check_id: checkId, p_items: items })).error).not.toBeNull();
  });

  it('needs a valid decision for every item', async () => {
    const items = await decisions(checkId, () => 'godkand');
    expect((await as.lst05.rpc('review_self_check', { p_self_check_id: checkId, p_items: items.slice(1) })).error?.message).toMatch(/every item/);
    items[0].decision = 'kanske';
    expect((await as.lst05.rpc('review_self_check', { p_self_check_id: checkId, p_items: items })).error?.message).toMatch(/invalid decision/);
  });

  it('all items approved gives Godkänd; a later review with a deficiency gives Brister; a site visit wins', async () => {
    const approve = await as.lst05.rpc('review_self_check', {
      p_self_check_id: checkId, p_items: await decisions(checkId, () => 'godkand'), p_comment: 'Bra.',
    });
    expect(approve.error).toBeNull();
    expect(approve.data.outcome).toBe('godkand');
    expect((await status('lst05')).A1).toBe('godkand');

    const brist = await as.lst05.rpc('review_self_check', {
      p_self_check_id: checkId, p_items: await decisions(checkId, (i) => (i === 2 ? 'brist' : 'godkand')),
    });
    expect(brist.data.outcome).toBe('brister');
    expect((await status('lst05')).A1).toBe('brister');

    const visit = await as.lst05.rpc('review_self_check', {
      p_self_check_id: checkId, p_items: await decisions(checkId, (i) => (i === 0 ? 'platsbesok' : i === 2 ? 'brist' : 'godkand')),
    });
    expect(visit.data.outcome).toBe('platsbesok');
    expect((await status('lst05')).A1).toBe('platsbesok');
    expect((await status('ownerAdminA')).A1).toBe('platsbesok');
  });

  it('the owner can read the reviews and item decisions; others cannot', async () => {
    for (const caller of ALL_CALLERS) {
      const reviews = await rows<{ id: string }>(as[caller].from('self_check_reviews').select('id').eq('self_check_id', checkId));
      const items = await rows(as[caller].from('self_check_item_reviews').select('review_id').in('review_id', reviews.map((r) => r.id).concat(randomUUID())));
      const allowed = ['ownerAdminA', 'caretakerA', 'lst05'].includes(caller);
      expect(reviews.length, caller).toBe(allowed ? 3 : 0);
      expect(items.length, caller).toBe(allowed ? 3 * template.items.length : 0);
    }
    const { data: all } = await admin.from('self_check_reviews').select('id').eq('self_check_id', checkId);
    for (const caller of ['ownerAdminB', 'lst06', 'kommun0580'] as const) {
      expect(await rows(as[caller].from('self_check_item_reviews').select('review_id').in('review_id', all!.map((r) => r.id))), caller).toEqual([]);
    }
  });

  it('reviews cannot be changed afterwards, and are in the audit log', async () => {
    const { data: r } = await admin.from('self_check_reviews').select('id').eq('self_check_id', checkId).limit(1).single();
    expect((await admin.from('self_check_reviews').update({ outcome: 'godkand' }).eq('id', r!.id)).error?.message).toMatch(/cannot be changed/);
    const { data: audit } = await admin.from('audit_log').select('actor_id').eq('table_name', 'self_check_reviews').eq('shelter_id', fx.shelters.A1);
    expect(audit!.length).toBe(3);
    expect(audit!.every((a) => a.actor_id === fx.users.lst05.id)).toBe(true);
  });
});

describe('cancelling an order', () => {
  it('only the issuing länsstyrelse can cancel an open order', async () => {
    const { data: o } = await admin.from('orders').select('id').eq('shelter_id', fx.shelters.B1).is('cancelled_at', null).single();
    for (const caller of ['ownerAdminB', 'lst06', 'kommun0581', 'anon'] as const) {
      expect((await as[caller].rpc('cancel_order', { p_order_id: o!.id })).error, caller).not.toBeNull();
    }
    const ok = await as.lst05.rpc('cancel_order', { p_order_id: o!.id });
    expect(ok.error).toBeNull();
    expect(ok.data.cancelled_by).toBe(fx.users.lst05.id);
    expect((await status('lst05')).B1).toBe('ej_forelagd');
  });

  it('an answered order cannot be cancelled', async () => {
    const { data: o } = await admin.from('orders').select('id').eq('shelter_id', fx.shelters.A1).single();
    expect((await as.lst05.rpc('cancel_order', { p_order_id: o!.id })).error?.message).toMatch(/only open orders/);
  });
});

describe('no direct writes', () => {
  it('no caller can write orders, notices or reviews directly', async () => {
    for (const caller of ALL_CALLERS) {
      for (const table of ['orders', 'order_notices', 'self_check_reviews', 'self_check_item_reviews']) {
        expect((await as[caller].from(table).insert({ id: randomUUID() })).error, `${caller} ${table}`).not.toBeNull();
      }
      await as[caller].from('orders').update({ due_date: day(90) }).eq('shelter_id', fx.shelters.A2);
    }
    const { data } = await admin.from('orders').select('due_date').eq('shelter_id', fx.shelters.A2).single();
    expect(data!.due_date).toBe(day(-1));
  });
});
