import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { dateOnly } from '../../src/core/utils/dates.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { runRetentionReminders } from '../../src/jobs/retentionReminders.js';
import { projectCost } from '../../src/modules/billing/projectCost.service.js';
import { addMonths } from '../../src/modules/closeout/closeout.shared.js';
import { bearer, loginMunshi, projectRow, useFreshDatabase } from '../helpers.js';
import { mockPdf, pdfCalls, pmWithFinancials } from '../billing/fixtures.js';
import { addDays, api, attachment, owner, pm, rs, subcontractorId, today, workerId, type Auth } from '../labor/fixtures.js';

const seeded = useFreshDatabase();
const munshi = async (): Promise<Auth> => bearer((await loginMunshi(seeded().malik.id)).accessToken);
const audits = (action: string) => prismaAdmin.auditLog.count({ where: { tenantId: seeded().malik.id, action } });

async function newSnag(auth: Auth, projectId: string, body: Record<string, unknown> = {}) {
  const res = await api()
    .post(`/api/v1/projects/${projectId}/snags`)
    .set(auth)
    .send({ location: 'Lounge — east wall', description: 'Hairline crack above the window', ...body });
  if (res.status !== 201) throw new Error(`snag ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; number: number; code: string; status: string };
}

describe('Step 17 — drawings', () => {
  it('a new revision supersedes the latest; old revisions stay visible; Munshi views but cannot manage', async () => {
    const o = await owner();
    const dha = seeded().projects.dha.id;
    const f0 = await attachment(o, 'DOCUMENT');
    const created = await api()
      .post(`/api/v1/projects/${dha}/drawings`)
      .set(o)
      .send({ folder: 'ARCHITECTURAL', title: 'Ground floor plan', number: 'A-101', revision: { attachmentId: f0, approvedAt: '2026-03-02', notes: 'Society set' } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ folder: 'ARCHITECTURAL', revisionCount: 1, latest: { revisionNo: 0, isLatest: true, approvedAt: '2026-03-02' } });
    const id = created.body.data.id as string;

    // A site photo is not a drawing file.
    const photo = await attachment(o, 'SITE_PHOTO');
    expect((await api().post(`/api/v1/drawings/${id}/revisions`).set(o).send({ attachmentId: photo })).body.error.code).toBe('INVALID_ATTACHMENT');

    const f1 = await attachment(o, 'DOCUMENT');
    const r1 = await api().post(`/api/v1/drawings/${id}/revisions`).set(o).send({ attachmentId: f1, notes: 'Window moved' });
    expect(r1.status).toBe(201);
    expect(r1.body.data.revisions.map((r: { revisionNo: number; isLatest: boolean }) => [r.revisionNo, r.isLatest])).toEqual([
      [1, true],
      [0, false],
    ]);
    expect(r1.body.data.latest).toMatchObject({ revisionNo: 1, file: { id: f1 } });
    expect(r1.body.data.revisions[1].file.id).toBe(f0);

    const m = await munshi();
    const list = await api().get(`/api/v1/projects/${dha}/drawings`).set(m);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.folders).toEqual([{ folder: 'ARCHITECTURAL', count: 1 }]);
    const detail = await api().get(`/api/v1/drawings/${id}`).set(m);
    expect(detail.body.data.revisions).toHaveLength(2);
    expect((await api().post(`/api/v1/drawings/${id}/revisions`).set(m).send({ attachmentId: f1 })).status).toBe(403);

    // Approve the revision later; filter by folder.
    const approved = await api().patch(`/api/v1/drawing-revisions/${r1.body.data.latest.id}`).set(o).send({ approvedAt: '2026-06-20' });
    expect(approved.body.data.latest.approvedAt).toBe('2026-06-20');
    expect((await api().get(`/api/v1/projects/${dha}/drawings?folder=MEP`).set(o)).body.data.items).toHaveLength(0);

    expect(await audits('drawing.create')).toBe(1);
    expect(await audits('drawing.revision_add')).toBe(1);
    expect(await audits('drawing.revision_update')).toBe(1);
    expect((await api().delete(`/api/v1/drawings/${id}`).set(o)).body.data).toEqual({ id, deleted: true });
    expect(await prismaAdmin.drawingRevision.count({ where: { drawingId: id } })).toBe(0);
    expect(await audits('drawing.delete')).toBe(1);
  });
});

describe('Step 17 — snags', () => {
  it('status flow OPEN → FIXED → VERIFIED → reopen; Munshi logs and fixes, the office verifies; clientId is idempotent', async () => {
    const m = await munshi();
    const o = await owner();
    const dha = seeded().projects.dha.id;
    const before = await attachment(m, 'SITE_PHOTO');
    const clientId = uuidv7();
    const body = { clientId, location: 'Master bedroom', description: 'Plaster crack over the lintel', beforePhotoIds: [before], workerId: await workerId(seeded().malik.id, 'Ustad Akram'), targetDate: addDays(today(), -1) };
    const first = await api().post(`/api/v1/projects/${dha}/snags`).set(m).send(body);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ number: 1, code: 'SN-001', status: 'OPEN', overdue: true, inDefectPeriod: false, assignee: { type: 'WORKER', name: expect.stringContaining('Akram') } });
    expect(first.body.data.beforePhotos).toHaveLength(1);
    expect(first.body.data.cost).not.toHaveProperty('amountPaisa');
    const again = await api().post(`/api/v1/projects/${dha}/snags`).set(m).send(body);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    const id = first.body.data.id as string;

    expect((await api().post(`/api/v1/projects/${dha}/snags`).set(m).send({ description: 'No place given' })).body.error.code).toBe('LOCATION_REQUIRED');
    expect((await api().post(`/api/v1/snags/${id}/verify`).set(o).send({})).body.error.code).toBe('INVALID_SNAG_STATUS');

    const after = await attachment(m, 'SITE_PHOTO');
    const fixed = await api().post(`/api/v1/snags/${id}/fix`).set(m).send({ afterPhotoIds: [after], note: 'Filled and re-plastered' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data).toMatchObject({ status: 'FIXED', fixNote: 'Filled and re-plastered', fixedBy: { name: 'Rafaqat Ali' }, overdue: false });
    expect(fixed.body.data.afterPhotos).toHaveLength(1);
    expect((await api().post(`/api/v1/snags/${id}/verify`).set(m).send({})).status).toBe(403);

    const verified = await api().post(`/api/v1/snags/${id}/verify`).set(await pm()).send({ note: 'Checked' });
    expect(verified.body.data).toMatchObject({ status: 'VERIFIED', verifiedBy: { name: expect.any(String) } });
    expect((await api().patch(`/api/v1/snags/${id}`).set(o).send({ description: 'Changed' })).body.error.code).toBe('SNAG_VERIFIED');

    const reopened = await api().post(`/api/v1/snags/${id}/reopen`).set(o).send({ reason: 'Crack is back' });
    expect(reopened.body.data).toMatchObject({ status: 'OPEN', reopenCount: 1, lastReopenReason: 'Crack is back', fixedAt: null, verifiedAt: null });

    const list = await api().get(`/api/v1/projects/${dha}/snags?status=OPEN`).set(m);
    expect(list.body.data.items.map((s: { id: string }) => s.id)).toEqual([id]);
    expect(list.body.data.summary).toMatchObject({ open: 1, fixed: 0, verified: 0, overdue: 1 });
    expect(list.body.data.summary).not.toHaveProperty('reworkPaisa');
    expect(list.body.meta).toMatchObject({ page: 1, total: 1 });

    for (const action of ['snag.create', 'snag.fix', 'snag.verify', 'snag.reopen']) expect(await audits(action), action).toBe(1);
  });

  it('cost: REWORK → project cost, SUBCONTRACTOR_DEDUCTION → sub-contract DEDUCTION (reversed on change), CHANGE_ORDER only a flag; amounts gated', async () => {
    const t = seeded().malik.id;
    const dha = seeded().projects.dha.id;
    const o = await owner();
    const sharif = await subcontractorId(t, 'Ustad Sharif Shuttering');
    const assignment = (await api().post(`/api/v1/projects/${dha}/labor/subcontracts`).set(o).send({ subcontractorId: sharif, scope: 'Shuttering', rateType: 'PER_SQFT' })).body.data as { id: string };
    const snag = await newSnag(o, dha, { subcontractorId: sharif });
    const cost = (auth: Auth, body: Record<string, unknown>) => api().put(`/api/v1/snags/${snag.id}/cost`).set(auth).send(body);
    const losses = async () => (await prismaAdmin.$transaction((tx) => projectCost(tx, t, dha))).lossesPaisa;
    const deductions = () => prismaAdmin.subcontractLedgerEntry.findMany({ where: { tenantId: t, assignmentId: assignment.id, type: 'DEDUCTION' }, orderBy: { createdAt: 'asc' } });

    // PM without fields.amounts can't set it; amount required.
    expect((await cost(await pm(), { attribution: 'REWORK', amountPaisa: rs(12000) })).status).toBe(403);
    expect((await cost(o, { attribution: 'REWORK' })).body.error.code).toBe('AMOUNT_REQUIRED');

    const base = await losses();
    const rework = await cost(o, { attribution: 'REWORK', amountPaisa: rs(12000), note: 'Paint + painter' });
    expect(rework.body.data.cost).toMatchObject({ attribution: 'REWORK', amountPaisa: rs(12000), postedTo: 'PROJECT_COST' });
    expect(await losses()).toBe(base + 1_200_000n);

    const deduction = await cost(o, { attribution: 'SUBCONTRACTOR_DEDUCTION', amountPaisa: rs(4500) });
    expect(deduction.body.data.cost).toMatchObject({ attribution: 'SUBCONTRACTOR_DEDUCTION', subcontractAssignmentId: assignment.id, postedTo: 'SUBCONTRACTOR_ACCOUNT' });
    expect(await losses()).toBe(base); // no longer project cost
    expect((await deductions()).map((e) => [e.amountPaisa, e.refType])).toEqual([[-450_000n, 'SNAG']]);
    const account = await api().get(`/api/v1/subcontract-assignments/${assignment.id}/ledger`).set(o);
    expect(account.body.data.account.deductionsPaisa).toBe(rs(4500));

    // Same values again: no new ledger rows. A change order: the deduction is reversed, nothing posted.
    await cost(o, { attribution: 'SUBCONTRACTOR_DEDUCTION', amountPaisa: rs(4500), note: 'note only' });
    expect(await deductions()).toHaveLength(1);
    const co = await cost(o, { attribution: 'CHANGE_ORDER', amountPaisa: rs(25000), note: 'Owner wants a bigger window' });
    expect(co.body.data.cost).toMatchObject({ attribution: 'CHANGE_ORDER', amountPaisa: rs(25000), postedTo: 'CHANGE_ORDER_FLAG' });
    expect((await deductions()).map((e) => [e.amountPaisa, e.refType])).toEqual([
      [-450_000n, 'SNAG'],
      [450_000n, 'SNAG_REVERSAL'],
    ]);
    expect(await losses()).toBe(base);

    // Munshi sees the attribution, never the amount; the owner sees totals.
    const m = await munshi();
    const seen = await api().get(`/api/v1/snags/${snag.id}`).set(m);
    expect(seen.body.data.cost.attribution).toBe('CHANGE_ORDER');
    expect(seen.body.data.cost).not.toHaveProperty('amountPaisa');
    expect((await api().put(`/api/v1/snags/${snag.id}/cost`).set(m).send({ attribution: 'NONE' })).status).toBe(403);
    expect((await api().get(`/api/v1/projects/${dha}/snags`).set(o)).body.data.summary).toMatchObject({ changeOrderPaisa: rs(25000), reworkPaisa: '0' });
    // A PM with the money permissions may set it.
    expect((await cost(await pmWithFinancials(t), { attribution: 'NONE' })).body.data.cost).toMatchObject({ attribution: 'NONE', amountPaisa: '0', postedTo: null });
    expect(await audits('snag.cost')).toBe(5);
    // Deleting needs an open snag without a cost.
    expect((await api().delete(`/api/v1/snags/${snag.id}`).set(o)).status).toBe(200);
  });
});

describe('Step 17 — handover and retention', () => {
  async function closeoutProject() {
    const t = seeded().malik.id;
    const p = await projectRow(t, 'Gulberg · 1 Kanal', { status: 'CLOSEOUT' });
    await prismaAdmin.projectBillingStage.create({ data: { tenantId: t, projectId: p.id, sortOrder: 1, label: 'Retention', percent: 5, isRetention: true, amountPaisa: 50_000_000n } });
    return p;
  }

  it('checklist + sign-off → complete: HANDED_OVER, retention due = handover + defect period; invoice due date; sub-contractor retention held', async () => {
    mockPdf();
    const o = await owner();
    const t = seeded().malik.id;
    const p = await closeoutProject();
    const h = (path = '') => `/api/v1/projects/${p.id}/handover${path}`;

    const empty = await api().get(h()).set(o);
    expect(empty.body.data).toMatchObject({ projectStatus: 'CLOSEOUT', canComplete: false, blockers: ['ITEMS_PENDING', 'SIGN_OFF_MISSING'], signOff: null, defectPeriodMonths: 6 });
    expect(empty.body.data.items).toHaveLength(7);
    expect((await api().post(h('/complete')).set(o).send({})).body.error).toMatchObject({ code: 'HANDOVER_INCOMPLETE', details: { blockers: ['ITEMS_PENDING', 'SIGN_OFF_MISSING'] } });
    expect((await api().get(h('/certificate')).set(o)).body.error.code).toBe('SIGN_OFF_MISSING');

    for (const key of ['KEYS', 'ELECTRICITY_CONNECTION', 'GAS_CONNECTION', 'WATER_CONNECTION', 'WARRANTY_CARDS', 'FINAL_DRAWINGS', 'FINAL_PHOTOS']) {
      expect((await api().put(h(`/items/${key}`)).set(o).send({ done: true, note: key === 'KEYS' ? '3 sets' : undefined })).status).toBe(200);
    }
    expect((await api().put(h('/items/ROOF')).set(o).send({ done: true })).status).toBe(400);
    const signature = await attachment(o, 'SITE_PHOTO');
    const signed = await api().post(h('/sign-off')).set(o).send({ ownerName: 'Ahmed Raza', signedOn: today(), signatureAttachmentId: signature });
    expect(signed.body.data).toMatchObject({ canComplete: true, blockers: [], signOff: { ownerName: 'Ahmed Raza', signedOn: today() } });

    // An open snag blocks unless accepted; a PM (no projects.project.manage) can't complete.
    await newSnag(o, p.id);
    expect((await api().post(h('/complete')).set(await pm()).send({})).status).toBe(403);
    expect((await api().post(h('/complete')).set(o).send({})).body.error).toMatchObject({ code: 'OPEN_SNAGS', details: { count: 1 } });

    const handoverDate = addDays(today(), -3);
    const done = await api().post(h('/complete')).set(o).send({ handoverDate, acceptOpenSnags: true });
    expect(done.status).toBe(200);
    const due = addMonths(handoverDate, 6);
    expect(done.body.data).toMatchObject({ projectStatus: 'HANDED_OVER', handedOverAt: handoverDate, retentionDueDate: due });
    expect((await prismaAdmin.project.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('HANDED_OVER');
    expect(await audits('handover.complete')).toBe(1);
    expect(await audits('handover.item')).toBe(7);
    expect(await audits('handover.sign_off')).toBe(1);

    // Certificate PDF (Urdu = right-to-left, no money).
    const cert = await api().get(h('/certificate?lang=ur')).set(o);
    expect(cert.status).toBe(200);
    expect(cert.body.data).toMatchObject({ attachmentId: expect.any(String), url: expect.any(String), whatsappText: expect.stringContaining('Gulberg') });
    expect(pdfCalls.at(-1)!.html).toContain('dir="rtl"');
    expect(pdfCalls.at(-1)!.html).toContain('حوالگی سرٹیفکیٹ');
    expect(pdfCalls.at(-1)!.html).not.toContain('Rs ');

    // RETENTION invoice: due at the end of the defect period.
    const inv = await api().post(`/api/v1/projects/${p.id}/invoices`).set(o).send({ type: 'RETENTION' });
    expect(inv.status).toBe(201);
    expect(inv.body.data.dueDate).toBe(due);

    // Retention view: owner sees amounts; PM without amounts sees dates only.
    const r = await api().get(`/api/v1/projects/${p.id}/retention`).set(o);
    expect(r.body.data).toMatchObject({ retentionDueDate: due, handedOverAt: handoverDate, client: { hasRetentionStage: true, amountPaisa: '50000000', invoice: { dueDate: due } }, defectSnags: { total: 0, open: 0 } });
    await prismaAdmin.userProjectAccess.create({ data: { tenantId: t, projectId: p.id, userId: (await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: t, role: 'PM' } })).id } });
    const pmView = await api().get(`/api/v1/projects/${p.id}/retention`).set(await pm());
    expect(pmView.status).toBe(200);
    expect(pmView.body.data.retentionDueDate).toBe(due);
    expect(pmView.body.data.client).not.toHaveProperty('amountPaisa');
    expect(pmView.body.data.totals).toEqual({});
    expect((await api().get(`/api/v1/projects/${p.id}/retention`).set(await munshi())).status).toBe(403);

    // Sub-contractor retention is held until the same date.
    const assignment = await prismaAdmin.subcontractAssignment.create({
      data: { tenantId: t, projectId: p.id, subcontractorId: await subcontractorId(t, 'Haji Plumbing Works'), scope: 'Plumbing', rateType: 'LUMPSUM', contractValuePaisa: 10_000_000n, startDate: dateOnly(addDays(today(), -90)) },
    });
    const release = await api().post(`/api/v1/subcontract-assignments/${assignment.id}/payments`).set(o).send({ type: 'RETENTION_RELEASE', amountPaisa: rs(1000), paidFrom: 'BANK' });
    expect(release.status).toBe(409);
    expect(release.body.error).toMatchObject({ code: 'RETENTION_HELD', details: { releaseDate: due } });

    // Defect-period snags: flagged while the period runs, refused after it.
    const defect = await newSnag(o, p.id, { description: 'Seepage after rain' });
    expect((await api().get(`/api/v1/snags/${defect.id}`).set(o)).body.data.inDefectPeriod).toBe(true);
    await prismaAdmin.projectHandover.update({ where: { tenantId_projectId: { tenantId: t, projectId: p.id } }, data: { retentionDueDate: dateOnly(addDays(today(), -1)) } });
    expect((await api().post(`/api/v1/projects/${p.id}/snags`).set(o).send({ location: 'Roof', description: 'Another leak' })).body.error.code).toBe('DEFECT_PERIOD_ENDED');
  });

  it('PATCH status → HANDED_OVER also records the handover date and retention due date', async () => {
    const o = await owner();
    const p = await projectRow(seeded().malik.id, 'Askari 11', { status: 'CLOSEOUT' });
    expect((await api().patch(`/api/v1/projects/${p.id}/status`).set(o).send({ status: 'HANDED_OVER' })).status).toBe(200);
    const h = await prismaAdmin.projectHandover.findFirstOrThrow({ where: { projectId: p.id } });
    expect(h.handedOverAt && h.retentionDueDate).toBeTruthy();
    expect(dateOnly(addMonths(today(), 6)).getTime()).toBe(h.retentionDueDate!.getTime());
  });

  it('reminder job: N days before the due date, then on the due date — once each, owner only (money)', async () => {
    const t = seeded().malik.id;
    const p = await projectRow(t, 'Bahria Orchard', { status: 'HANDED_OVER' });
    const h = await prismaAdmin.projectHandover.create({
      data: { tenantId: t, projectId: p.id, handedOverAt: dateOnly(addDays(today(), -170)), defectPeriodMonths: 6, retentionDueDate: dateOnly(addDays(today(), 10)), reminderDaysBefore: 14 },
    });
    await prismaAdmin.snag.create({ data: { tenantId: t, projectId: p.id, number: 1, description: 'Seepage', location: 'Roof', inDefectPeriod: true } });
    const notes = () => prismaAdmin.notification.findMany({ where: { tenantId: t, type: 'RETENTION_RELEASE_DUE', refId: h.id }, include: { user: { select: { role: true } } } });

    const first = await runRetentionReminders();
    expect(first.reminders).toContain(p.id);
    const sent = await notes();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((n) => n.user.role === 'THEKEDAR')).toBe(true);
    expect(sent[0]!.body).toContain('1');
    expect((await runRetentionReminders()).reminders).not.toContain(p.id);
    expect(await notes()).toHaveLength(sent.length);

    await prismaAdmin.projectHandover.update({ where: { id: h.id }, data: { retentionDueDate: dateOnly(today()) } });
    const dueRun = await runRetentionReminders(new Date(Date.now() + 13 * 3_600_000));
    expect(dueRun.due).toContain(p.id);
    expect((await notes()).length).toBe(sent.length * 2);
    expect((await prismaAdmin.projectHandover.findUniqueOrThrow({ where: { id: h.id } })).retentionDueNotifiedAt).not.toBeNull();
  });
});

describe('Step 17 — offline sync', () => {
  it('Munshi pulls snags (no money) and drawings; pushes SNAG_CREATE and SNAG_FIX', async () => {
    const s = await loginMunshi(seeded().malik.id);
    const m = bearer(s.accessToken);
    const dha = seeded().projects.dha.id;
    const o = await owner();
    const costed = await newSnag(o, dha);
    await api().put(`/api/v1/snags/${costed.id}/cost`).set(o).send({ attribution: 'REWORK', amountPaisa: rs(5000) });
    const f0 = await attachment(o, 'DOCUMENT');
    await api().post(`/api/v1/projects/${dha}/drawings`).set(o).send({ folder: 'STRUCTURAL', title: 'Slab steel', revision: { attachmentId: f0 } });

    const pulled = (await api().get('/api/v1/sync/pull').set(m)).body.data;
    const snag = pulled.changes.snags.upserts.find((x: { id: string }) => x.id === costed.id);
    expect(snag).toMatchObject({ code: 'SN-001', status: 'OPEN' });
    expect(JSON.stringify(snag)).not.toMatch(/cost|amount/i);
    expect(pulled.changes.drawings.upserts[0]).toMatchObject({ title: 'Slab steel', latestRevisionNo: 0, latestAttachmentId: f0, revisionCount: 1 });

    const photo = await attachment(m, 'SITE_PHOTO');
    const createId = uuidv7();
    const push = await api()
      .post('/api/v1/sync/push')
      .set(m)
      .send({ mutations: [{ clientId: createId, type: 'SNAG_CREATE', payload: { projectId: dha, clientId: createId, location: 'Stairs', description: 'Nosing broken', beforePhotoIds: [photo] } }] });
    expect(push.status).toBe(200);
    expect(push.body.data.results[0]).toMatchObject({ status: 'APPLIED' });
    const serverId = push.body.data.results[0].serverId as string;
    const fix = await api()
      .post('/api/v1/sync/push')
      .set(m)
      .send({ mutations: [{ clientId: uuidv7(), type: 'SNAG_FIX', payload: { snagId: serverId, afterPhotoIds: [photo] } }] });
    expect(fix.body.data.results[0]).toMatchObject({ status: 'APPLIED' });
    expect((await prismaAdmin.snag.findUniqueOrThrow({ where: { id: serverId } })).status).toBe('FIXED');
  });
});

describe('Step 17 — seed', () => {
  it('Malik & Sons closeout demo: drawings with 2 revisions, snags in every status, Johar in CLOSEOUT with a partly filled checklist; idempotent', async () => {
    const { withSeedSnapshot } = await import('../helpers.js');
    const { seedMalikCloseout } = await import('../../prisma/seedCloseout.js');
    const s = seeded();
    await withSeedSnapshot('malik_demo', s);
    const input = { tenantId: s.malik.id, ownerId: s.users.khalid.id, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id, projects: s.projects };
    expect(await seedMalikCloseout(prismaAdmin, input)).toEqual({ skipped: false });
    expect(await seedMalikCloseout(prismaAdmin, input)).toEqual({ skipped: true });

    const o = await owner();
    const drawings = (await api().get(`/api/v1/projects/${s.projects.dha.id}/drawings`).set(o)).body.data;
    expect(drawings.items.filter((d: { revisionCount: number }) => d.revisionCount === 2)).toHaveLength(2);
    const johar = (await api().get(`/api/v1/projects/${s.projects.johar.id}/snags`).set(o)).body.data.summary;
    expect(johar).toMatchObject({ open: 2, fixed: 1, verified: 1, reworkPaisa: rs(12000) });
    const handover = (await api().get(`/api/v1/projects/${s.projects.johar.id}/handover`).set(o)).body.data;
    expect(handover.projectStatus).toBe('CLOSEOUT');
    expect(handover.items.filter((i: { done: boolean }) => i.done)).toHaveLength(4);
    const dhaSnags = (await api().get(`/api/v1/projects/${s.projects.dha.id}/snags`).set(o)).body.data.summary;
    expect(dhaSnags).toMatchObject({ open: 1, verified: 1, deductionPaisa: rs(4500) });
    const valencia = (await api().get(`/api/v1/projects/${s.projects.valencia.id}/retention`).set(o)).body.data;
    expect(valencia).toMatchObject({ projectStatus: 'HANDED_OVER', daysToDue: 10, defectSnags: { open: 1 } });
  });
});
