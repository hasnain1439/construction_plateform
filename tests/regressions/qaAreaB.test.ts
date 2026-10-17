/**
 * QA fixes, area B — API behaviour on the Malik & Sons demo (`malik_reports`: schedule, control,
 * change orders, billing, tax):
 *   QA-B-02  durable WhatsApp share links (/public/files/:id) — change orders + invoices
 *   QA-B-03 / 11 / 12 / 15  report PDFs: landscape, Urdu subtitles, export file names
 *   QA-B-08 / 09 / 20  X-Lang: alerts, delay note, tax note + report notes, plan-version notes
 *   QA-B-10  milestone progress re-checks material overuse; alerts carry lastEvaluatedAt
 *   QA-B-14  invoice PDF made again after a payment
 *   QA-B-16  change-order WhatsApp text follows the status
 *   QA-B-17  P&L projected margin hidden from the Accountant
 *   QA-B-22  0-working-day stoppage: warning, not an excusable reason
 *   QA-B-26  milestone templateKey
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { setPdfRenderer } from '../../src/core/pdf/renderer.js';
import { fileSignature, shareSignature, shareUrl } from '../../src/modules/attachments/storage.provider.js';
import { addDays } from '../../src/modules/billing/billing.shared.js';
import { api, bearer, loginMobile, pathOf, pngBytes, SEED, upload, useFreshDatabase, withSeedSnapshot } from '../helpers.js';
import { today } from '../billing/fixtures.js';

const seeded = useFreshDatabase();
type Auth = Record<string, string>;
type Call = { html: string; lang: string; landscape: boolean | undefined };
const calls: Call[] = [];
beforeEach(async () => {
  calls.length = 0;
  setPdfRenderer({ render: async (html, o) => (calls.push({ html, lang: o.lang, landscape: o.landscape }), Buffer.from('%PDF-1.4 test')) });
  await withSeedSnapshot('malik_reports', seeded());
});
afterEach(() => setPdfRenderer(null));

const owner = async (): Promise<Auth> => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async (): Promise<Auth> => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const dha = () => seeded().projects.dha.id;
const tid = () => seeded().malik.id;
const rs = (rupees: number) => String(Math.round(rupees * 100));
const get = async (auth: Auth, path: string, headers: Record<string, string> = {}) => {
  const res = await api().get(path).set(auth).set(headers);
  expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(200);
  return res.body.data;
};
const URDU = /[؀-ۿ]/;

async function newCo(auth: Auth, body: Record<string, unknown> = {}) {
  const res = await api()
    .post(`/api/v1/projects/${dha()}/change-orders`)
    .set(auth)
    .send({ title: 'Extra outdoor light points', type: 'ADDITION', markupPercent: 15, daysImpact: 2, lines: [{ kind: 'OTHER', description: 'Light point', unit: 'job', quantity: 5, ratePaisa: rs(5500) }], ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; code: string };
}

describe('QA-B-02 — durable share links', () => {
  it('change-order slip: the WhatsApp link is /public/files/:id, valid for SHARE_LINK_TTL_DAYS, and still opens long after the file-link TTL', async () => {
    const o = await owner();
    const co = await newCo(o);
    const share = await get(o, `/api/v1/change-orders/${co.id}/pdf?lang=en`);
    expect(share.url).toContain(`/api/v1/public/files/${share.attachmentId}?`);
    expect(share.whatsappText).toContain(share.url);
    expect(share.fileUrl).toContain(`/api/v1/attachments/${share.attachmentId}/file/`);
    const days = (Date.parse(share.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(env.SHARE_LINK_TTL_DAYS - 0.01);

    // the link opens: 302 to a fresh short-lived signed file URL that serves the PDF under its name
    const hit = await api().get(pathOf(share.url));
    expect(hit.status).toBe(302);
    expect(hit.headers['cache-control']).toBe('no-store');
    const file = await api().get(pathOf(hit.headers['location']!)).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toMatch(/^inline; filename="CO-\d{3} MSB-/);

    // A link issued 2 hours ago (12 × the 10-minute file TTL) still opens; a file link of that time does not.
    const issued = Date.now() - 2 * 3_600_000;
    const old = shareUrl(share.attachmentId, tid(), issued);
    expect((await api().get(pathOf(old.url))).status).toBe(302);
    const oldExp = Math.floor(issued / 1000) + env.SIGNED_URL_TTL_SECONDS;
    const oldFile = await api().get(`/api/v1/attachments/${share.attachmentId}/file?tid=${tid()}&exp=${oldExp}&sig=${fileSignature(share.attachmentId, tid(), oldExp)}`);
    expect(oldFile.body.error.code).toBe('LINK_EXPIRED');
  });

  it('invoice share uses the same durable link; bad signature / expired / other company / file signature / non-PDF are refused', async () => {
    const o = await owner();
    const draft = await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'OTHER', lines: [{ description: 'Extra boundary wall', quantity: 10, unit: 'rft', ratePaisa: rs(1500) }] });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(o).send({})).status).toBe(200);
    const share = await get(o, `/api/v1/invoices/${draft.body.data.id}/pdf?lang=en`);
    expect(share.url).toContain('/api/v1/public/files/');
    expect(share.whatsappText).toContain(share.url);
    const id = share.attachmentId as string;
    expect((await api().get(pathOf(share.url))).status).toBe(302);

    const url = new URL(share.url);
    const sig = url.searchParams.get('sig')!;
    url.searchParams.set('sig', (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1));
    expect((await api().get(pathOf(url.toString()))).body.error.code).toBe('INVALID_SIGNATURE');
    const past = Math.floor(Date.now() / 1000) - 60;
    expect((await api().get(`/api/v1/public/files/${id}?tid=${tid()}&exp=${past}&sig=${shareSignature(id, tid(), past)}`)).body.error.code).toBe('LINK_EXPIRED');
    const future = Math.floor(Date.now() / 1000) + 3600;
    const other = seeded().ahmed.id;
    expect((await api().get(`/api/v1/public/files/${id}?tid=${other}&exp=${future}&sig=${shareSignature(id, other, future)}`)).status).toBe(404);
    // a file-link signature (purpose attachment:) never opens a share link
    expect((await api().get(`/api/v1/public/files/${id}?tid=${tid()}&exp=${future}&sig=${fileSignature(id, tid(), future)}`)).body.error.code).toBe('INVALID_SIGNATURE');
    // only server-made PDFs: an uploaded photo with a valid share signature is not served
    const photo = (await upload(o.Authorization!.slice(7), 'SITE_PHOTO', pngBytes())).body.data.id as string;
    expect((await api().get(`/api/v1/public/files/${photo}?tid=${tid()}&exp=${future}&sig=${shareSignature(photo, tid(), future)}`)).status).toBe(404);
  });
});

describe('QA-B-16 — change-order WhatsApp text follows the status', () => {
  it('SENT asks for approval; APPROVED only informs', async () => {
    const o = await owner();
    const co = await newCo(o);
    expect((await get(o, `/api/v1/change-orders/${co.id}/pdf?lang=en`)).whatsappText).toContain('2 extra working days. Please reply OK to approve');
    const approved = await api().post(`/api/v1/change-orders/${co.id}/approve`).set(o).send({ proofType: 'VERBAL', proofNote: 'Owner agreed on site' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const text = (await get(o, `/api/v1/change-orders/${co.id}/pdf?lang=en`)).whatsappText as string;
    expect(text).not.toContain('reply OK');
    expect(text).toContain('Status: Approved');
    expect(calls.at(-1)!.html).toContain('+2 working days');
  });
});

describe('QA-B-03 / 11 / 12 / 15 — report files', () => {
  it('variance book PDF: landscape, split material table with a filled Total row, Urdu subtitle; export named variance-<code>-<date>.pdf', async () => {
    const o = await owner();
    const file = await get(o, `/api/v1/reports/variance/${dha()}?format=pdf&lang=ur`);
    expect(file.fileName).toBe(`variance-${seeded().projects.dha.code}-${today()}.pdf`);
    expect(file.url).toContain(`/file/${encodeURIComponent(file.fileName)}?`);
    expect(file.downloadUrl).toContain('dl=1');
    const c = calls.at(-1)!;
    expect(c.landscape).toBe(true);
    expect(c.html).toContain('data-part="2"');
    expect(c.html).toMatch(/<tr class="total">/);
    expect(c.html).toContain('تک'); // "as of" in Urdu
    expect(c.html).toContain('تخمینہ نظرِ ثانی');
    expect(c.html).not.toContain('as of');
    expect(c.html).not.toMatch(/Rs [\d,]+\.\d\d/); // whole rupees

    const dl = await api().get(pathOf(file.downloadUrl)).buffer(true);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="${file.fileName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  });

  it('tax reports: WHT summary PDF in Urdu is landscape; xlsx named tax-invoice-register-<date>.xlsx; CSV money in whole rupees', async () => {
    const o = await owner();
    await get(o, '/api/v1/reports/wht-summary?format=pdf&lang=ur');
    expect(calls.at(-1)!.landscape).toBe(true);
    expect(calls.at(-1)!.html).toContain('ٹیکس سال');
    const xl = await get(o, '/api/v1/reports/tax-invoice-register?format=xlsx&lang=ur');
    expect(xl.fileName).toBe(`tax-invoice-register-${today()}.xlsx`);
    const csv = await get(o, '/api/v1/reports/change-orders?format=csv&lang=en');
    const body = (await api().get(pathOf(csv.url)).buffer(true)).text ?? '';
    expect(body).not.toMatch(/,\d+\.\d\d,/);
  });
});

describe('QA-B-20 — X-Lang', () => {
  it('alerts, the tax adviser note, tax report notes / subtitle and the delay note follow X-Lang; invalid values are ignored', async () => {
    const o = await owner();
    const en = await get(o, `/api/v1/projects/${dha()}/control/alerts`, { 'X-Lang': 'en' });
    const ur = await get(o, `/api/v1/projects/${dha()}/control/alerts`, { 'X-Lang': 'ur' });
    expect(en.items.length).toBeGreaterThan(0);
    expect(URDU.test(en.items[0].title)).toBe(false);
    expect(URDU.test(ur.items[0].title)).toBe(true);
    const none = await get(o, `/api/v1/projects/${dha()}/control/alerts`);
    const bad = await get(o, `/api/v1/projects/${dha()}/control/alerts`, { 'X-Lang': 'fr' });
    expect(bad.items[0].title).toBe(none.items[0].title);
    expect(ur.items[0].lastEvaluatedAt).toEqual(expect.any(String));

    expect(URDU.test((await get(o, '/api/v1/tax/settings', { 'X-Lang': 'ur' })).adviserNote)).toBe(true);
    const wht = await get(o, '/api/v1/reports/wht-summary', { 'X-Lang': 'ur' });
    expect(wht.subtitle).toContain('تمام پروجیکٹ');
    expect(wht.noteCodes.map((n: { code: string }) => n.code)).toContain('TAX_ADVISER');
    expect(URDU.test(wht.notes.at(-1))).toBe(true);
    expect(wht.columns.map((c: { key: string }) => c.key)).toEqual(['client', 'ntn', 'month', 'payments', 'gross', 'cashReceived', 'wht', 'whtRate', 'certificatesReceived', 'certificatesMissing', 'whtWithoutCertificate']);
    const plain = await get(o, '/api/v1/reports/tax-invoice-register');
    expect(plain.subtitle).toMatch(/^All projects · Tax year /);
    expect(plain.noteCodes.map((n: { code: string }) => n.code).slice(-2)).toEqual(['TAX_FROZEN', 'TAX_ADVISER']);

    const delays = await get(o, `/api/v1/projects/${dha()}/schedule/delays`, { 'X-Lang': 'roman' });
    const slow = delays.categories.flatMap((c: { reasons: Array<{ reason: string; note: string }> }) => c.reasons).find((r: { reason: string }) => r.reason === 'SLOW_PROGRESS');
    if (slow) expect(slow.note).toMatch(/^Kaam [\d.]+% hua, plan ki \d+% raftaar se$/);
  });

  it('CORS allows the X-Lang header', async () => {
    const pre = await api().options('/api/v1/projects').set('Origin', process.env['CORS_ORIGINS']!.split(',')[0]!).set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization,x-lang');
    expect(pre.status).toBe(204);
    expect(String(pre.headers['access-control-allow-headers']).toLowerCase()).toContain('x-lang');
  });
});

describe('QA-B-09 / 26 — plan versions and milestones', () => {
  it('moving a milestone writes a readable note (values, reader language); milestones carry templateKey', async () => {
    const o = await owner();
    const s = await get(o, `/api/v1/projects/${dha()}/schedule`);
    const m = (s.milestones as Array<{ id: string; key: string; name: string; status: string; templateKey: string | null }>).find((x) => x.status === 'PLANNED')!;
    expect(m.templateKey).toBe(m.key);
    const date = addDays(today(), 40);
    const res = await api().patch(`/api/v1/milestones/${m.id}`).set(o).send({ startNoEarlierThan: date });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const versions = await get(o, `/api/v1/projects/${dha()}/schedule/versions`, { 'X-Lang': 'en' });
    const v = versions.find((x: { reason: string }) => x.reason === 'MILESTONE_EDITED');
    expect(v.note).toBe(`${m.name}: earliest start set to ${new Date(`${date}T00:00:00Z`).getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`);
    const delay = await get(o, `/api/v1/projects/${dha()}/control/delay-analysis`, { 'X-Lang': 'roman' });
    expect(delay.timeline.find((e: { kind: string; title: string }) => e.kind === 'PLAN_VERSION' && e.title === 'MILESTONE_EDITED').detail).toContain('sab se pehle shuru');
    expect(delay.milestones.find((x: { id: string }) => x.id === m.id).templateKey).toBe(m.key);

    await api().patch(`/api/v1/milestones/${m.id}`).set(o).send({ name: 'Custom name' }).expect(200);
    expect((await get(o, `/api/v1/projects/${dha()}/schedule`)).milestones.find((x: { id: string }) => x.id === m.id).templateKey).toBeNull();
  });
});

describe('QA-B-10 — progress re-checks material overuse', () => {
  it('a progress write re-evaluates MATERIAL_OVERUSE: the alert agrees with the variance table', async () => {
    const o = await owner();
    const before = Date.now() - 1000;
    const s = await get(o, `/api/v1/projects/${dha()}/schedule`);
    const slab = (s.milestones as Array<{ id: string; key: string; status: string; progressPercent: number }>).find((x) => x.key === 'F1_STRUCTURE.SLAB')!;
    const res = await api().post(`/api/v1/milestones/${slab.id}/progress`).set(o).send({ status: 'IN_PROGRESS', progressPercent: 95 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const alerts = (await get(o, `/api/v1/projects/${dha()}/control/alerts?status=ALL`)).items as Array<{ rule: string; status: string; refId: string; lastEvaluatedAt: string; details: { variancePercent: number } }>;
    const mv = await get(o, `/api/v1/projects/${dha()}/control/material-variance`);
    const cement = (mv.items as Array<{ materialId: string; description: string; status: string; variancePercent: number }>).find((i) => i.description === 'Cement OPC')!;
    const alert = alerts.find((a) => a.rule === 'MATERIAL_OVERUSE' && a.refId === cement.materialId)!;
    expect(Date.parse(alert.lastEvaluatedAt)).toBeGreaterThanOrEqual(before);
    if (cement.status === 'OVER') expect(alert).toMatchObject({ status: 'OPEN', details: { variancePercent: cement.variancePercent } });
    else expect(alert.status).toBe('RESOLVED');
  });
});

describe('QA-B-14 — invoice PDF after a payment', () => {
  it('the stored PDF is dropped when a payment changes Received / Balance; the next download (any language) shows them', async () => {
    const o = await owner();
    const draft = await api().post(`/api/v1/projects/${dha()}/invoices`).set(o).send({ type: 'OTHER', lines: [{ description: 'Gate', quantity: 1, unit: 'job', ratePaisa: rs(50000) }] });
    const id = draft.body.data.id as string;
    await api().post(`/api/v1/invoices/${id}/issue`).set(o).send({}).expect(200);
    await get(o, `/api/v1/invoices/${id}/pdf?lang=en`);
    expect(calls.filter((c) => c.html.includes('INVOICE')).at(-1)!.html).not.toContain('Balance due');
    const paid = await api().post(`/api/v1/projects/${dha()}/payments`).set(o).send({ receivedOn: today(), method: 'BANK_TRANSFER', amountPaisa: rs(20000), allocations: [{ invoiceId: id, amountPaisa: rs(20000) }] });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect((await prismaAdmin.invoice.findUniqueOrThrow({ where: { id } })).pdfAttachmentId).toBeNull();
    calls.length = 0;
    await get(o, `/api/v1/invoices/${id}/pdf?lang=en`);
    expect(calls.at(-1)!.html).toContain('Balance due');
    expect(calls.at(-1)!.html).toContain('Rs 30,000');
  });
});

describe('QA-B-17 — P&L projected margin', () => {
  it('the Accountant (no fields.profit) gets no projected margin / EAC keys; the owner does', async () => {
    const o = await owner();
    const full = await get(o, '/api/v1/finance/pnl');
    expect(full.projects[0]).toHaveProperty('estimateAtCompletionPaisa');
    expect(full.totals).toHaveProperty('projectedMarginPaisa');
    const roles = (await get(o, '/api/v1/roles')) as Array<{ id: string; key: string }>;
    await api().patch(`/api/v1/users/${seeded().users.bilal.id}/role`).set(o).send({ roleId: roles.find((r) => r.key === 'ACCOUNTANT')!.id }).expect(200);
    const acc = await get(await pm(), '/api/v1/finance/pnl');
    expect(acc.projects.length).toBeGreaterThan(0);
    for (const row of acc.projects) for (const k of ['projectedMarginPercent', 'projectedMarginPaisa', 'estimateAtCompletionPaisa', 'projectedMarginBasis']) expect(row).not.toHaveProperty(k);
    expect(acc.totals).not.toHaveProperty('projectedMarginPaisa');
    expect(acc.totals).not.toHaveProperty('projectedMarginPercent');
    expect(acc).not.toHaveProperty('projectedMarginNote');
    expect(acc.totals).toHaveProperty('grossProfitToDatePaisa');
  });
});

describe('QA-B-22 — stoppage on an off day', () => {
  it('accepted with days 0 + warning NO_WORKING_DAYS; once approved it is no excusable reason', async () => {
    const o = await owner();
    const settings = await prismaAdmin.tenantSettings.findUnique({ where: { tenantId: tid() }, select: { workingDays: true } });
    const working = new Set(settings?.workingDays?.length ? settings.workingDays : ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']);
    const names = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    let off = addDays(today(), 20);
    while (working.has(names[new Date(`${off}T00:00:00Z`).getUTCDay()]!)) off = addDays(off, 1);
    const res = await api().post(`/api/v1/projects/${dha()}/stoppages`).set(o).send({ dates: [off], reason: 'HOLIDAY', note: 'QA-B off day' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ days: 0, warning: 'NO_WORKING_DAYS' });
    await api().post(`/api/v1/stoppages/${res.body.data.id}/approve`).set(o).send({}).expect(200);
    const d = await get(o, `/api/v1/projects/${dha()}/schedule/delays`);
    const reasons = d.categories.flatMap((c: { reasons: Array<{ stoppageId: string | null; days: number }> }) => c.reasons);
    expect(reasons.find((r: { stoppageId: string | null }) => r.stoppageId === res.body.data.id)).toBeUndefined();
    expect(reasons.every((r: { days: number }) => r.days > 0)).toBe(true);
  });
});
