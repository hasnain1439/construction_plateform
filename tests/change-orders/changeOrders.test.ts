import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { bearer, loginMunshi, pngBytes, SEED, useFreshDatabase } from '../helpers.js';
import { mockPdf, pdfCalls, stagesOf } from '../billing/fixtures.js';
import { api, attachment, materialId, owner, pm, rs, today, type Auth } from '../labor/fixtures.js';

const seeded = useFreshDatabase();
const munshi = async (): Promise<Auth> => bearer((await loginMunshi(seeded().malik.id)).accessToken);
const audits = (action: string) => prismaAdmin.auditLog.count({ where: { tenantId: seeded().malik.id, action } });
const dha = () => seeded().projects.dha.id;
const MONEY_KEYS = ['ratePaisa', 'amountPaisa', 'priceRatePaisa', 'priceAmountPaisa', 'totalPaisa', 'costPaisa', 'markupPaisa', 'markupPercent', 'approvedChangesPaisa', 'revisedContractPaisa', 'pendingPaisa'];
const noMoney = (v: unknown) => {
  const json = JSON.stringify(v);
  for (const k of MONEY_KEYS) expect(json, k).not.toContain(`"${k}"`);
};

/** A lump-sum OTHER line (cost rate in rupees). */
const other = (description: string, quantity: number, rupees: number) => ({ kind: 'OTHER', description, unit: 'sqft', quantity, ratePaisa: rs(rupees) });

async function newCo(auth: Auth, body: Record<string, unknown> = {}, projectId = dha()) {
  const res = await api()
    .post(`/api/v1/projects/${projectId}/change-orders`)
    .set(auth)
    .send({ title: 'Extra bathroom tiles', type: 'ADDITION', markupPercent: 10, lines: [other('Wall tiles to the ceiling', 100, 200)], ...body });
  if (res.status !== 201) throw new Error(`co ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; code: string; status: string; totalPaisa: string; number: number };
}

async function approveVerbal(auth: Auth, id: string, extra: Record<string, unknown> = {}) {
  const res = await api().post(`/api/v1/change-orders/${id}/approve`).set(auth).send({ proofType: 'VERBAL', proofNote: 'Owner agreed on site with Bilal', ...extra });
  if (res.status !== 200) throw new Error(`approve ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Gives a user one extra permission (ALLOW override). */
async function allow(phone: string, key: string) {
  const u = await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: seeded().malik.id, phone } });
  await prismaAdmin.userPermissionOverride.create({ data: { tenantId: seeded().malik.id, userId: u.id, permissionKey: key, effect: 'ALLOW' } });
  await prismaAdmin.user.update({ where: { id: u.id }, data: { permVersion: { increment: 1 } } });
}

describe('Step 15 — change order builder', () => {
  it('material rate from the approved estimate / price list, labour rate, markup, totals; deduction is negative; rates need fields.rates', async () => {
    const o = await owner();
    const t = seeded().malik.id;
    const tiles = await materialId(t, 'Floor tiles');
    const tileLaying = await prismaAdmin.laborRate.findFirstOrThrow({ where: { tenantId: t, key: 'TILE_LAYING' } });
    const opts = await api().get(`/api/v1/projects/${dha()}/change-orders/rates`).set(o);
    expect(opts.status).toBe(200);
    const tileOpt = opts.body.data.materials.find((m: { materialId: string }) => m.materialId === tiles);
    expect(tileOpt).toMatchObject({ name: 'Floor tiles', unit: 'sqft', rateSource: expect.stringMatching(/ESTIMATE|PRICE_LIST/) });
    const tileRate = BigInt(tileOpt.ratePaisa);
    expect(opts.body.data.labour.find((l: { laborRateId: string }) => l.laborRateId === tileLaying.id)).toMatchObject({ unit: 'sqft', ratePaisa: rs(45) });
    expect(opts.body.data.milestones.length).toBeGreaterThan(3);

    const res = await api()
      .post(`/api/v1/projects/${dha()}/change-orders`)
      .set(o)
      .send({
        title: 'Extra bathroom tiles',
        type: 'ADDITION',
        markupPercent: 10,
        daysImpact: 3,
        lines: [
          { kind: 'MATERIAL', materialId: tiles, quantity: 120 },
          { kind: 'LABOUR', laborRateId: tileLaying.id, quantity: 120 },
          other('Grout and spacers', 1, 1500),
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const co = res.body.data;
    expect(co).toMatchObject({ code: 'CO-001', status: 'DRAFT', source: 'MANUAL', type: 'ADDITION', daysImpact: 3, lineCount: 3, markupPercent: 10 });
    expect(co.lines[0]).toMatchObject({ kind: 'MATERIAL', description: 'Floor tiles', unit: 'sqft', quantity: 120, ratePaisa: tileRate.toString(), rateSource: tileOpt.rateSource });
    expect(co.lines[1]).toMatchObject({ kind: 'LABOUR', description: 'Tile laying', rateSource: 'LABOUR_RATE', ratePaisa: rs(45), priceRatePaisa: rs(49.5), amountPaisa: rs(45 * 120), priceAmountPaisa: rs(49.5 * 120) });
    const cost = tileRate * 120n + BigInt(rs(45 * 120)) + BigInt(rs(1500));
    expect(co.costPaisa).toBe(cost.toString());
    const price = co.lines.reduce((s: bigint, l: { priceAmountPaisa: string }) => s + BigInt(l.priceAmountPaisa), 0n);
    expect(co.totalPaisa).toBe(price.toString());
    expect(BigInt(co.markupPaisa)).toBe(price - cost);

    // A deduction is stored negative; a VERBAL proof needs a note even on a draft.
    const ded = await newCo(o, { title: 'Boundary plaster left out', type: 'DEDUCTION', markupPercent: 0, lines: [other('Boundary wall plaster', 800, 45)] });
    expect(ded).toMatchObject({ code: 'CO-002', totalPaisa: `-${rs(36000)}` });
    const noNote = await api().post(`/api/v1/projects/${dha()}/change-orders`).set(o).send({ title: 'Verbal one', type: 'ADDITION', proofType: 'VERBAL' });
    expect(noNote.body.error.code).toBe('PROOF_NOTE_REQUIRED');
    expect((await api().post(`/api/v1/projects/${dha()}/change-orders`).set(o).send({ title: 'No rate', type: 'ADDITION', lines: [{ kind: 'OTHER', description: 'x', unit: 'job', quantity: 1 }] })).body.error.code).toBe('LINE_INCOMPLETE');

    // Edit: new markup re-prices; only drafts.
    const edited = await api().patch(`/api/v1/change-orders/${co.id}`).set(o).send({ markupPercent: 0 });
    expect(edited.body.data.totalPaisa).toBe(cost.toString());
    expect(await audits('changeorder.create')).toBe(2);
    expect(await audits('changeorder.update')).toBe(1);

    // The Munshi has no change-order access; a PM sees rates (fields.rates) but may not set markup without it.
    const m = await munshi();
    expect((await api().get(`/api/v1/projects/${dha()}/change-orders`).set(m)).status).toBe(403);
    expect((await api().get(`/api/v1/change-orders/${co.id}`).set(m)).status).toBe(403);
    const p = await pm();
    const pmView = await api().get(`/api/v1/change-orders/${co.id}`).set(p);
    expect(pmView.status).toBe(200);
    expect(pmView.body.data).toHaveProperty('costPaisa');
  });

  it('money is hidden without fields.rates / fields.amounts; the slip PDF needs a price permission', async () => {
    const o = await owner();
    const co = await newCo(o);
    // The Munshi given changeorder.view only: the change order without a single amount.
    await allow(SEED.malik.munshi.phone, 'changeorder.view');
    const m = await munshi();
    const one = await api().get(`/api/v1/change-orders/${co.id}`).set(m);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ code: co.code, lineCount: 1 });
    noMoney(one.body.data);
    const list = await api().get(`/api/v1/projects/${dha()}/change-orders`).set(m);
    noMoney(list.body.data);
    const pdf = await api().get(`/api/v1/change-orders/${co.id}/pdf`).set(m);
    expect(pdf.status).toBe(403);
    expect(pdf.body.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('Step 15 — approval, revised contract and dates', () => {
  it('approval needs proof (verbal → note, screenshot → file); approved COs revise the contract, the end date and the delay breakdown; the estimate baseline stays', async () => {
    const o = await owner();
    const before = (await api().get(`/api/v1/projects/${dha()}/receivables`).set(o)).body.data;
    expect(before.approvedChangesPaisa).toBe('0');
    const original = BigInt(before.originalContractPaisa);
    const est = await prismaAdmin.estimate.findFirstOrThrow({ where: { projectId: dha(), status: 'APPROVED' } });

    const add = await newCo(o, { daysImpact: 5 });
    const ded = await newCo(o, { title: 'Less plaster', type: 'DEDUCTION', markupPercent: 0, lines: [other('Boundary plaster', 100, 50)], daysImpact: 0 });

    expect((await api().post(`/api/v1/change-orders/${add.id}/send`).set(o).send({})).body.data.status).toBe('SENT');
    const noProof = await api().post(`/api/v1/change-orders/${add.id}/approve`).set(o).send({});
    expect(noProof.body.error.code).toBe('PROOF_REQUIRED');
    expect((await api().post(`/api/v1/change-orders/${add.id}/approve`).set(o).send({ proofType: 'VERBAL' })).body.error.code).toBe('PROOF_NOTE_REQUIRED');
    expect((await api().post(`/api/v1/change-orders/${add.id}/approve`).set(o).send({ proofType: 'VERBAL', proofNote: 'ok' })).body.error.code).toBe('PROOF_NOTE_REQUIRED');
    expect((await api().post(`/api/v1/change-orders/${add.id}/approve`).set(o).send({ proofType: 'WHATSAPP_SCREENSHOT' })).body.error.code).toBe('PROOF_FILE_REQUIRED');
    const shot = await attachment(o, 'SITE_PHOTO');
    const approved = await api().post(`/api/v1/change-orders/${add.id}/approve`).set(o).send({ proofType: 'WHATSAPP_SCREENSHOT', proofAttachmentIds: [shot], approvedOn: today() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', approvedOn: today(), proofType: 'WHATSAPP_SCREENSHOT', proofCount: 1, approvedBy: { name: 'Khalid Malik' } });
    expect(approved.body.data.proofFiles).toHaveLength(1);
    // A pending (draft) deduction does not count yet; once approved it lowers the contract.
    await approveVerbal(o, ded.id);

    const rec = (await api().get(`/api/v1/projects/${dha()}/receivables`).set(o)).body.data;
    const changes = BigInt(add.totalPaisa) + BigInt(ded.totalPaisa);
    expect(rec.approvedChangesPaisa).toBe(changes.toString());
    expect(rec.originalContractPaisa).toBe(original.toString());
    expect(rec.revisedContractPaisa).toBe((original + changes).toString());

    const project = (await api().get(`/api/v1/projects/${dha()}`).set(o)).body.data;
    expect(project.changeOrders).toMatchObject({ approvedCount: 2, daysImpact: 5, originalEndDate: '2027-02-15', approvedChangesPaisa: changes.toString(), revisedContractPaisa: (original + changes).toString() });
    expect(project.changeOrders.revisedEndDate > '2027-02-19').toBe(true); // 5 working days (Friday / holidays skipped)

    const schedule = await prismaAdmin.schedule.findFirstOrThrow({ where: { projectId: dha() } });
    expect(schedule.changeOrderDays).toBe(5);
    const delays = (await api().get(`/api/v1/projects/${dha()}/schedule/delays`).set(o)).body.data;
    expect(delays.days.changeOrders).toBe(5);
    expect(delays.days.total).toBe(delays.days.owner + delays.days.excusable + delays.days.contractor + delays.days.changeOrders);
    expect(delays.changeOrders.items.map((i: { code: string }) => i.code)).toEqual(['CO-001', 'CO-002']);
    const ownerCat = delays.categories.find((c: { category: string }) => c.category === 'OWNER');
    expect(ownerCat.days).toBe(delays.days.owner + 5);
    expect(ownerCat.reasons).toContainEqual(expect.objectContaining({ reason: 'CHANGE_ORDER', changeOrderId: add.id, days: 5 }));

    // Estimate: approved baseline untouched + the changes layer.
    const estDto = (await api().get(`/api/v1/estimates/${est.id}`).set(o)).body.data;
    expect(estDto.totalPaisa).toBe(est.totalPaisa.toString());
    expect(estDto.changes).toMatchObject({ count: 2, daysImpact: 5 });
    expect(BigInt(estDto.changes.revisedTotalPaisa)).toBe(est.totalPaisa + BigInt(estDto.changes.costPaisa));
    expect((await prismaAdmin.estimate.findUniqueOrThrow({ where: { id: est.id } })).totalPaisa).toBe(est.totalPaisa);

    // The status flow after approval; approve twice → 409.
    expect((await api().post(`/api/v1/change-orders/${add.id}/approve`).set(o).send({ proofType: 'VERBAL', proofNote: 'again please' })).body.error.code).toBe('INVALID_CHANGE_ORDER_STATUS');
    expect((await api().patch(`/api/v1/change-orders/${add.id}`).set(o).send({ title: 'Changed later' })).body.error.code).toBe('CHANGE_ORDER_LOCKED');
    expect((await api().post(`/api/v1/change-orders/${add.id}/start`).set(o).send({})).body.data.status).toBe('IN_PROGRESS');
    expect((await api().post(`/api/v1/change-orders/${add.id}/complete`).set(o).send({})).body.data.status).toBe('COMPLETED');
    for (const action of ['changeorder.send', 'changeorder.approve', 'changeorder.start', 'changeorder.complete']) expect(await audits(action), action).toBeGreaterThan(0);
  });

  it('reject → reopen → draft again; delete a draft; the list summary counts by status', async () => {
    const o = await owner();
    const co = await newCo(o);
    expect((await api().post(`/api/v1/change-orders/${co.id}/reject`).set(o).send({ reason: 'Too expensive' })).body.data).toMatchObject({ status: 'REJECTED', rejectionReason: 'Too expensive' });
    expect((await api().post(`/api/v1/change-orders/${co.id}/start`).set(o).send({})).body.error.code).toBe('INVALID_CHANGE_ORDER_STATUS');
    expect((await api().post(`/api/v1/change-orders/${co.id}/reopen`).set(o).send({})).body.data).toMatchObject({ status: 'DRAFT', rejectionReason: null });
    const second = await newCo(o, { title: 'Second one' });
    const list = (await api().get(`/api/v1/projects/${dha()}/change-orders`).set(o)).body.data;
    expect(list.items.map((x: { code: string }) => x.code)).toEqual(['CO-002', 'CO-001']);
    expect(list.summary.byStatus).toMatchObject({ DRAFT: 2, REJECTED: 0 });
    expect(BigInt(list.summary.pendingPaisa)).toBe(BigInt(co.totalPaisa) + BigInt(second.totalPaisa));
    expect((await api().delete(`/api/v1/change-orders/${second.id}`).set(o)).body.data).toEqual({ id: second.id, deleted: true });
    expect(await audits('changeorder.delete')).toBe(1);
    expect(await audits('changeorder.reject')).toBe(1);
  });
});

describe('Step 15 — billing link', () => {
  it('NEXT_STAGE: the next stage invoice carries the CO line; issuing bills it, cancelling reverts; a deduction cannot be its own invoice', async () => {
    const o = await owner();
    const co = await newCo(o);
    await approveVerbal(o, co.id, { billingMode: 'NEXT_STAGE' });
    const ded = await newCo(o, { title: 'Less plaster', type: 'DEDUCTION', markupPercent: 0, lines: [other('Boundary plaster', 100, 50)] });
    await approveVerbal(o, ded.id);
    expect((await api().post(`/api/v1/change-orders/${ded.id}/bill`).set(o).send({ mode: 'VARIATION' })).body.error.code).toBe('DEDUCTION_NEEDS_STAGE');
    const dedBill = await api().post(`/api/v1/change-orders/${ded.id}/bill`).set(o).send({ mode: 'NEXT_STAGE' });
    expect(dedBill.body.data).toMatchObject({ invoice: null, changeOrder: { billingMode: 'NEXT_STAGE' } });

    const stage = (await stagesOf(dha())).find((st) => st.status === 'UPCOMING' && !st.isRetention);
    const draft = await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'STAGE', billingStageId: stage!.id, force: true, forceNote: 'test' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const coLines = draft.body.data.lines.filter((l: { sourceType: string }) => l.sourceType === 'CHANGE_ORDER');
    expect(coLines.map((l: { description: string; amountPaisa: string }) => [l.description, l.amountPaisa])).toEqual([
      ['CO-001 · Extra bathroom tiles', co.totalPaisa],
      ['CO-002 · Less plaster', ded.totalPaisa],
    ]);
    expect(draft.body.data.subtotalPaisa).toBe((stage!.amountPaisa + BigInt(co.totalPaisa) + BigInt(ded.totalPaisa)).toString());
    // Already on a live (draft) invoice.
    expect((await api().post(`/api/v1/change-orders/${co.id}/bill`).set(o).send({ mode: 'VARIATION' })).body.error.code).toBe('CHANGE_ORDER_ALREADY_BILLED');
    expect((await api().get(`/api/v1/change-orders/${co.id}`).set(o)).body.data.invoice).toMatchObject({ id: draft.body.data.id, type: 'STAGE', status: 'DRAFT' });

    const issued = await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(o).send({});
    expect(issued.status).toBe(200);
    expect((await api().get(`/api/v1/change-orders/${co.id}`).set(o)).body.data).toMatchObject({ status: 'BILLED', billedAt: expect.any(String) });
    expect(await audits('changeorder.billed')).toBe(2);
    // Still counts in the revised contract once billed.
    expect((await api().get(`/api/v1/projects/${dha()}/receivables`).set(o)).body.data.approvedChangesPaisa).toBe((BigInt(co.totalPaisa) + BigInt(ded.totalPaisa)).toString());

    const cancelled = await api().post(`/api/v1/invoices/${draft.body.data.id}/cancel`).set(o).send({ reason: 'Wrong stage' });
    expect(cancelled.status).toBe(200);
    expect((await api().get(`/api/v1/change-orders/${co.id}`).set(o)).body.data).toMatchObject({ status: 'APPROVED', billedAt: null, invoice: null });
  });

  it('VARIATION: own invoice with the CO lines at the owner price; issuing marks it BILLED; the PM cannot bill', async () => {
    const o = await owner();
    const co = await newCo(o, { lines: [other('Wall tiles to the ceiling', 100, 200), other('Skirting', 40, 100)] });
    expect((await api().post(`/api/v1/change-orders/${co.id}/bill`).set(o).send({ mode: 'VARIATION' })).body.error.code).toBe('INVALID_CHANGE_ORDER_STATUS');
    await approveVerbal(o, co.id);
    const p = await pm();
    expect((await api().post(`/api/v1/change-orders/${co.id}/bill`).set(p).send({ mode: 'VARIATION' })).status).toBe(403);
    const billed = await api().post(`/api/v1/change-orders/${co.id}/bill`).set(o).send({ mode: 'VARIATION' });
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    expect(billed.body.data.invoice).toMatchObject({ type: 'VARIATION', status: 'DRAFT' });
    const inv = (await api().get(`/api/v1/invoices/${billed.body.data.invoice.id}`).set(o)).body.data;
    expect(inv.lines.map((l: { description: string; ratePaisa: string; amountPaisa: string }) => [l.description, l.ratePaisa, l.amountPaisa])).toEqual([
      ['CO-001 · Wall tiles to the ceiling', rs(220), rs(22000)],
      ['CO-001 · Skirting', rs(110), rs(4400)],
    ]);
    expect(inv.totalPaisa).toBe(co.totalPaisa);
    await api().post(`/api/v1/invoices/${inv.id}/issue`).set(o).send({}).expect(200);
    expect((await api().get(`/api/v1/change-orders/${co.id}`).set(o)).body.data.status).toBe('BILLED');
    const variations = await api().get(`/api/v1/projects/${dha()}/invoices?type=VARIATION`).set(o);
    expect(variations.body.data.map((i: { id: string }) => i.id)).toEqual([inv.id]);
    expect(await audits('changeorder.bill')).toBe(1);
  });
});

describe('Step 15 — site instructions and snags', () => {
  it('Munshi records an instruction (idempotent, own only, notifies the office); the PM converts it to a CO draft or dismisses one', async () => {
    const m = await munshi();
    const photo = await attachment(m, 'SITE_PHOTO');
    const clientId = uuidv7();
    const body = { clientId, note: 'Owner wants a skylight above the stairs', photoIds: [photo] };
    const first = await api().post(`/api/v1/projects/${dha()}/site-instructions`).set(m).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({ code: 'SI-001', status: 'NEW', createdBy: { name: 'Rafaqat Ali' }, changeOrder: null });
    expect(first.body.data.photos).toHaveLength(1);
    expect((await api().post(`/api/v1/projects/${dha()}/site-instructions`).set(m).send(body)).status).toBe(200);
    const notified = await prismaAdmin.notification.findMany({ where: { tenantId: seeded().malik.id, type: 'SITE_INSTRUCTION_CREATED' }, select: { userId: true } });
    expect(notified.length).toBeGreaterThan(0);
    expect(notified.map((n) => n.userId)).not.toContain(seeded().users.rafaqatMalik.id);

    const o = await owner();
    const other = await api().post(`/api/v1/projects/${dha()}/site-instructions`).set(o).send({ note: 'Owner asked for a second gate' });
    expect(other.status).toBe(201);
    // The Munshi sees only own instructions; the PM sees both.
    expect((await api().get(`/api/v1/projects/${dha()}/site-instructions`).set(m)).body.data.items.map((x: { code: string }) => x.code)).toEqual(['SI-001']);
    expect((await api().get(`/api/v1/site-instructions/${other.body.data.id}`).set(m)).status).toBe(404);
    const p = await pm();
    const pmList = await api().get(`/api/v1/projects/${dha()}/site-instructions`).set(p);
    expect(pmList.body.data.summary).toEqual({ new: 2, converted: 0, dismissed: 0 });
    expect((await api().post(`/api/v1/site-instructions/${first.body.data.id}/convert`).set(m).send({})).status).toBe(403);

    const conv = await api().post(`/api/v1/site-instructions/${first.body.data.id}/convert`).set(p).send({ daysImpact: 2 });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    expect(conv.body.data).toMatchObject({ status: 'DRAFT', source: 'SITE_INSTRUCTION', siteInstructionId: first.body.data.id, title: 'Owner wants a skylight above the stairs', daysImpact: 2, siteInstruction: { code: 'SI-001' } });
    expect(conv.body.data.siteInstruction.photos).toHaveLength(1);
    expect((await api().post(`/api/v1/site-instructions/${first.body.data.id}/convert`).set(p).send({})).body.error.code).toBe('SITE_INSTRUCTION_NOT_NEW');
    const after = (await api().get(`/api/v1/site-instructions/${first.body.data.id}`).set(m)).body.data;
    expect(after).toMatchObject({ status: 'CONVERTED', changeOrder: { code: conv.body.data.code } });
    noMoney(after);

    const dismissed = await api().post(`/api/v1/site-instructions/${other.body.data.id}/dismiss`).set(p).send({ reason: 'Done free of cost' });
    expect(dismissed.body.data).toMatchObject({ status: 'DISMISSED', dismissReason: 'Done free of cost' });
    // Deleting the CO draft puts the instruction back to NEW.
    await api().delete(`/api/v1/change-orders/${conv.body.data.id}`).set(p).expect(200);
    expect((await api().get(`/api/v1/site-instructions/${first.body.data.id}`).set(p)).body.data.status).toBe('NEW');
    for (const action of ['siteinstruction.create', 'siteinstruction.convert', 'siteinstruction.dismiss']) expect(await audits(action), action).toBeGreaterThan(0);
  });

  it('a CHANGE_ORDER snag becomes a CO draft (its amount as one line), once; other snags are refused', async () => {
    const o = await owner();
    const snag = await api().post(`/api/v1/projects/${dha()}/snags`).set(o).send({ location: 'Lounge', description: 'Owner wants a bigger window' });
    expect(snag.status).toBe(201);
    const id = snag.body.data.id as string;
    expect((await api().post(`/api/v1/snags/${id}/change-order`).set(o).send({})).body.error.code).toBe('SNAG_NOT_CHANGE_ORDER');
    await api().put(`/api/v1/snags/${id}/cost`).set(o).send({ attribution: 'CHANGE_ORDER', amountPaisa: rs(25000), note: 'Bigger window' }).expect(200);
    const summary = (await api().get(`/api/v1/projects/${dha()}/change-orders`).set(o)).body.data.summary;
    expect(summary.changeOrderSnags).toEqual([expect.objectContaining({ id, code: 'SN-001', amountPaisa: rs(25000) })]);

    const p = await pm();
    const res = await api().post(`/api/v1/snags/${id}/change-order`).set(p).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ source: 'SNAG', snagId: id, title: 'SN-001: Owner wants a bigger window', totalPaisa: rs(25000), snag: { code: 'SN-001' } });
    expect(res.body.data.lines).toEqual([expect.objectContaining({ kind: 'OTHER', quantity: 1, unit: 'job', ratePaisa: rs(25000) })]);
    expect((await api().post(`/api/v1/snags/${id}/change-order`).set(o).send({})).body.error.code).toBe('SNAG_ALREADY_CONVERTED');
    expect((await api().get(`/api/v1/projects/${dha()}/change-orders`).set(o)).body.data.summary.changeOrderSnags).toEqual([]);
  });
});

describe('Step 15 — slip PDF and sync', () => {
  it('slip PDF: owner prices only (no cost / markup), days, WhatsApp text', async () => {
    mockPdf();
    const o = await owner();
    const co = await newCo(o, { daysImpact: 2, markupPercent: 25, lines: [other('Wall tiles to the ceiling', 100, 200)] });
    const res = await api().get(`/api/v1/change-orders/${co.id}/pdf?lang=en`).set(o);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ attachmentId: expect.any(String), url: expect.any(String) });
    expect(res.body.data.whatsappText).toContain('CO-001');
    expect(res.body.data.whatsappText).toContain('2 extra working days');
    const html = pdfCalls.at(-1)!.html;
    expect(html).toContain('CHANGE ORDER');
    expect(html).toContain('Rs 250'); // price rate 200 × 1.25
    expect(html).toContain('Rs 25,000'); // total
    expect(html).not.toContain('Rs 200<'); // never the cost rate
    expect(html).toContain('+2 working days');
    expect(await audits('changeorder.pdf')).toBe(1);
  });

  it('sync: SITE_INSTRUCTION_CREATE is idempotent by clientId (photo by clientId); site_instructions pulls own rows without money', async () => {
    const s = await loginMunshi(seeded().malik.id);
    const auth = bearer(s.accessToken);
    const first = await api().get('/api/v1/sync/pull').set(auth);
    expect(first.status).toBe(200);
    expect(first.body.data.changes.site_instructions.upserts).toEqual([]);
    const cursor = first.body.data.cursor as string;
    const photoClient = uuidv7();
    const up = await api().post('/api/v1/attachments').set(auth).field('kind', 'SITE_PHOTO').field('clientId', photoClient).attach('file', pngBytes(), { filename: 'owner.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const batch = [{ clientId: uuidv7(), type: 'SITE_INSTRUCTION_CREATE', payload: { projectId: dha(), note: 'Owner wants the kitchen window 1 ft wider', photoIds: [photoClient] }, deviceCreatedAt: new Date().toISOString() }];
    const r1 = await api().post('/api/v1/sync/push').set(auth).send({ mutations: batch });
    expect(r1.body.data.results[0], JSON.stringify(r1.body)).toMatchObject({ status: 'APPLIED' });
    const r2 = await api().post('/api/v1/sync/push').set(auth).send({ mutations: batch });
    expect(r2.body.data.results[0]).toMatchObject({ status: 'DUPLICATE', serverId: r1.body.data.results[0].serverId });
    const rows = await prismaAdmin.siteInstruction.findMany({ where: { clientId: batch[0]!.clientId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.photoIds).toEqual([up.body.data.id]);

    // Someone else's instruction is not pulled by the Munshi.
    await api().post(`/api/v1/projects/${dha()}/site-instructions`).set(await owner()).send({ note: 'Office note for the owner' });
    const inc = await api().get(`/api/v1/sync/pull?cursor=${cursor}`).set(auth);
    const pulled = inc.body.data.changes.site_instructions.upserts as Array<Record<string, unknown>>;
    expect(pulled.map((x) => x['id'])).toEqual([rows[0]!.id]);
    expect(pulled[0]).toMatchObject({ code: 'SI-001', status: 'NEW', photoIds: [up.body.data.id], changeOrderId: null });
    noMoney(pulled);
  });
});

describe('Step 15 — seed', () => {
  it('Malik & Sons DHA: CO-001 BILLED on a VARIATION invoice, CO-002 SENT, CO-003 DRAFT from a site instruction; idempotent', async () => {
    const { withSeedSnapshot } = await import('../helpers.js');
    const { seedMalikChangeOrders } = await import('../../prisma/seedChangeOrders.js');
    await withSeedSnapshot('malik_demo', seeded());
    const s = seeded();
    const input = { tenantId: s.malik.id, ownerId: s.users.khalid.id, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id, dhaProjectId: dha() };
    expect(await seedMalikChangeOrders(prismaAdmin, input)).toEqual({ skipped: false });
    expect(await seedMalikChangeOrders(prismaAdmin, input)).toEqual({ skipped: true });
    const cos = await prismaAdmin.changeOrder.findMany({ where: { projectId: dha() }, orderBy: { number: 'asc' } });
    expect(cos.map((c) => [c.number, c.status, c.source])).toEqual([
      [1, 'BILLED', 'MANUAL'],
      [2, 'SENT', 'MANUAL'],
      [3, 'DRAFT', 'SITE_INSTRUCTION'],
    ]);
    const sis = await prismaAdmin.siteInstruction.findMany({ where: { projectId: dha() }, orderBy: { number: 'asc' } });
    expect(sis.map((x) => x.status)).toEqual(['CONVERTED', 'NEW']);
    const o = await owner();
    const rec = (await api().get(`/api/v1/projects/${dha()}/receivables`).set(o)).body.data;
    expect(rec.approvedChangesPaisa).toBe(cos[0]!.totalPaisa.toString());
    expect((await prismaAdmin.schedule.findFirstOrThrow({ where: { projectId: dha() } })).changeOrderDays).toBe(3);
    const variation = await prismaAdmin.invoice.findFirstOrThrow({ where: { projectId: dha(), type: 'VARIATION' } });
    expect(variation).toMatchObject({ status: 'ISSUED', totalPaisa: cos[0]!.totalPaisa });
  });
});
