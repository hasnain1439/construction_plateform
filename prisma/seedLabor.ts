/**
 * Demo labour & cash book for Malik & Sons (Phase 1 · Step 7). Idempotent: skipped when the
 * company already has workers on a project. Everything goes through the real services, so
 * settlements, advances, sub-contract ledgers and cash books are what the API would write.
 *
 * DHA Phase 6 timeline (2026): week 14–19 Sep approved and paid (Rs 68,400) · week 21–26 Sep
 * submitted (gross 83,600 − peshgi 12,500 = 71,100) · hazri 28 Sep – 2 Oct · Rafaqat's site
 * cash: opening 8,400 → Riaz peshgi → count −100 → Easypaisa float 50,000 → kharcha → 9,300,
 * top-up of 40,000 waiting. Asif (Bahria): float 75,000, spent 53,500 → 21,500.
 */
import { Prisma } from '../src/core/db/prisma.js';
import type { Tx } from '../src/core/db/withTenant.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { acknowledgeTx, approveExpenseTx, createCountTx, createExpenseTx, requestTopupTx, sendFloatTx } from '../src/modules/cashbook/cashbook.service.js';
import type { ExpenseInput } from '../src/modules/cashbook/cashbook.schema.js';
import { createAdvanceTx } from '../src/modules/labor/advances.service.js';
import { assignSubcontractTx, assignWorkerTx } from '../src/modules/labor/assignments.service.js';
import { markAttendanceTx } from '../src/modules/labor/attendance.service.js';
import type { AdvanceInput } from '../src/modules/labor/labor.schema.js';
import { addDays, type Actor } from '../src/modules/labor/labor.shared.js';
import { recordMeasurementTx, verifyMeasurementTx } from '../src/modules/labor/measurements.service.js';
import { approveTx, generateTx, payTx as payWagesTx, submitTx } from '../src/modules/labor/settlements.service.js';
import { payTx as paySubcontractTx, progressTx } from '../src/modules/labor/subcontracts.service.js';

const rs = (rupees: number) => BigInt(Math.round(rupees * 100));
const D = (v: string) => new Prisma.Decimal(v);
/** Calendar date at a Pakistan-time hour → UTC instant. */
const at = (date: string, hourPkt = 11, minute = 0) => new Date(`${date}T${String(hourPkt - 5).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);

export interface LaborSeedInput {
  tenantId: string;
  ownerId: string;
  bilalId: string;
  rafaqatId: string;
  asifId: string;
  projects: { dha: { id: string }; bahria: { id: string } };
}

type Status = 'FULL' | 'HALF' | 'ABSENT';

export async function seedMalikLabor(db: PrismaClient, s: LaborSeedInput): Promise<{ skipped: boolean }> {
  if ((await db.projectWorker.count({ where: { tenantId: s.tenantId } })) > 0) return { skipped: true };
  // All or nothing: a failure (e.g. a demo row changed while trying the app) leaves no half demo behind.
  await db.$transaction((tx) => build(db, s, (fn) => fn(tx)), { timeout: 300_000, maxWait: 30_000 });
  return { skipped: false };
}

async function build(db: PrismaClient, s: LaborSeedInput, run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>) {
  const khalid: Actor = { tenantId: s.tenantId, userId: s.ownerId, role: 'THEKEDAR', seesRates: true, seesFinancials: true };
  const bilal: Actor = { tenantId: s.tenantId, userId: s.bilalId, role: 'PM', seesRates: true, seesFinancials: false };
  const rafaqat: Actor = { tenantId: s.tenantId, userId: s.rafaqatId, role: 'MUNSHI', seesRates: false, seesFinancials: false };
  const asif: Actor = { tenantId: s.tenantId, userId: s.asifId, role: 'MUNSHI', seesRates: false, seesFinancials: false };
  const dha = s.projects.dha.id;
  const bahria = s.projects.bahria.id;

  const worker = async (name: string) => (await db.worker.findFirstOrThrow({ where: { tenantId: s.tenantId, name } })).id;
  const sub = async (name: string) => (await db.subcontractor.findFirstOrThrow({ where: { tenantId: s.tenantId, name } })).id;
  const W = {
    akram: await worker('Ustad Akram'),
    nadeem: await worker('Ustad Nadeem'),
    shahid: await worker('Shahid'),
    jameel: await worker('Jameel'),
    riaz: await worker('Riaz'),
    arif: await worker('Arif'),
    saleem: await worker('Saleem'),
    ghulam: await worker('Ghulam Rasool'),
  };

  const SUBS = ['Ustad Sharif Shuttering', 'Ustad Latif Steel Fixing', 'Haji Plumbing Works', 'Ali Electric Works'];
  // The demo uses these; re-activate them if they were switched off while trying the app.
  await db.worker.updateMany({ where: { tenantId: s.tenantId, id: { in: Object.values(W) } }, data: { isActive: true } });
  await db.subcontractor.updateMany({ where: { tenantId: s.tenantId, name: { in: SUBS } }, data: { isActive: true } });

  // ─── Team on site (DHA) ────────────────────────────────────────────────
  const rates: Array<[keyof typeof W, number, string]> = [
    ['akram', 2800, '2026-09-14'],
    ['nadeem', 2800, '2026-09-14'],
    ['shahid', 1600, '2026-09-14'],
    ['jameel', 1600, '2026-09-14'],
    ['riaz', 1600, '2026-09-14'],
    ['arif', 1600, '2026-09-14'],
    ['saleem', 1800, '2026-09-21'],
    ['ghulam', 1200, '2026-09-14'],
  ];
  await run(async (tx) => {
    for (const [key, rate, startDate] of rates) await assignWorkerTx(tx, khalid, dha, { workerId: W[key], dailyRatePaisa: rs(rate), startDate });
  });

  // ─── Hazri ─────────────────────────────────────────────────────────────
  /** [worker, Mon..Sat statuses, overtime hours per day]. Marked by the office (older than a munshi's 7 days). */
  const week = async (monday: string, marks: Array<[keyof typeof W, Status[], number[]?]>) => {
    for (let d = 0; d < 6; d++) {
      const date = addDays(monday, d);
      const entries = marks
        .filter(([, days]) => days[d])
        .map(([key, days, ot]) => ({ workerId: W[key], status: days[d]!, ...(ot?.[d] ? { overtimeHours: ot[d] } : {}) }));
      if (entries.length) await run((tx) => markAttendanceTx(tx, khalid, dha, { date, entries }, { at: at(date, 18) }));
    }
  };
  const F: Status = 'FULL';
  const H: Status = 'HALF';
  const A: Status = 'ABSENT';
  await week('2026-09-14', [
    ['akram', [F, F, F, F, F, F]],
    ['nadeem', [F, F, A, F, F, F]],
    ['shahid', [F, F, F, F, F, F]],
    ['jameel', [F, F, F, F, F, F]],
    ['riaz', [F, F, F, A, F, F]],
    ['arif', [F, F, A, A, A, A]],
    ['ghulam', [F, F, F, F, F, F]],
  ]);
  await week('2026-09-21', [
    ['akram', [F, F, F, F, F, F]],
    ['nadeem', [F, F, F, H, F, F]],
    ['shahid', [F, F, F, F, F, F]],
    ['jameel', [F, F, F, F, F, F]],
    ['riaz', [F, A, F, F, A, F]],
    ['arif', [F, F, F, F, F, F]],
    ['saleem', [F, F, A, F, F, F]],
    ['ghulam', [F, F, F, F, F, F]],
  ]);
  // 28 Sep – 2 Oct (Mon–Fri; settlement not generated yet)
  await week('2026-09-28', [
    ['akram', [F, F, F, F, F], [0, 0, 0, 0, 2]],
    ['nadeem', [F, F, F, F, F]],
    ['shahid', [F, F, F, F, F]],
    ['jameel', [F, F, F, A, F]],
    ['riaz', [F, F, F, H, F]],
    ['arif', [F, F, F, F, F]],
    ['saleem', [F, F, A, F, F]],
    ['ghulam', [F, F, F, F, F]],
  ]);

  // ─── Rafaqat's site cash: opening balance before the app ───────────────
  await run((tx) =>
    sendFloatTx(
      tx,
      khalid,
      { holderUserId: s.rafaqatId, amountPaisa: rs(8400), method: 'CASH', projectId: dha, note: 'Opening balance — cash in hand before the app' },
      { at: at('2026-09-21', 9), acknowledged: true },
    ),
  );

  // ─── Peshgi for the week of 21 Sep (office cash, Riaz from site cash) ──
  const advance = (a: Actor, input: Omit<AdvanceInput, 'payeeType'> & Partial<Pick<AdvanceInput, 'payeeType'>>, hour = 10) =>
    run((tx) => createAdvanceTx(tx, a, dha, { payeeType: 'WORKER', ...input }, { at: at(input.date, hour) }));
  await advance(khalid, { workerId: W.akram, amountPaisa: rs(5000), date: '2026-09-22', paidFrom: 'OFFICE_CASH', note: 'Child sick' });
  await advance(khalid, { workerId: W.shahid, amountPaisa: rs(2000), date: '2026-09-22', paidFrom: 'OFFICE_CASH' });
  await advance(rafaqat, { workerId: W.riaz, amountPaisa: rs(1500), date: '2026-09-23', paidFrom: 'SITE_CASH', note: 'Rent' });
  await advance(khalid, { workerId: W.arif, amountPaisa: rs(3000), date: '2026-09-24', paidFrom: 'OFFICE_CASH' });
  await advance(khalid, { workerId: W.saleem, amountPaisa: rs(1000), date: '2026-09-25', paidFrom: 'OFFICE_CASH' });

  // ─── Settlements ───────────────────────────────────────────────────────
  // 14–19 Sep: approved and paid from office cash (Rs 68,400)
  const first = await run((tx) => generateTx(tx, rafaqat, dha, '2026-09-14', { at: at('2026-09-19', 17) }));
  await run((tx) => submitTx(tx, rafaqat, first.id, { at: at('2026-09-19', 17, 10) }));
  const approved = await run((tx) => approveTx(tx, bilal, first.id, { at: at('2026-09-20', 10) }));
  await run((tx) => payWagesTx(tx, khalid, first.id, { lineIds: approved.lines!.map((l) => l.id), paidFrom: 'OFFICE_CASH' }, { at: at('2026-09-20', 12) }));
  // 21–26 Sep: submitted, waiting for approval (gross 83,600 − peshgi 12,500 = 71,100)
  const second = await run((tx) => generateTx(tx, rafaqat, dha, '2026-09-21', { at: at('2026-09-26', 17) }));
  await run((tx) => submitTx(tx, rafaqat, second.id, { at: at('2026-09-26', 17, 15) }));

  // ─── Sub-contractors on DHA (retention 5%) ─────────────────────────────
  const assign = (name: string, body: Omit<Parameters<typeof assignSubcontractTx>[3], 'subcontractorId'>) =>
    run(async (tx) => assignSubcontractTx(tx, khalid, dha, { subcontractorId: await sub(name), ...body }));
  const sharif = await assign('Ustad Sharif Shuttering', { scope: 'Slab & beam shuttering — ground + first floor', rateType: 'PER_SQFT', ratePaisa: rs(45), retentionPercent: 5, startDate: '2026-09-01' });
  const latif = await assign('Ustad Latif Steel Fixing', { scope: 'Steel fixing — footings, columns, slabs', rateType: 'PER_TON', ratePaisa: rs(9000), retentionPercent: 5, startDate: '2026-09-01' });
  const haji = await assign('Haji Plumbing Works', { scope: 'Plumbing rough-in — complete house', rateType: 'LUMPSUM', contractValuePaisa: rs(120000), retentionPercent: 5, startDate: '2026-09-10' });
  const ali = await assign('Ali Electric Works', { scope: 'Electrical conduit — covered area 3,950 sqft', rateType: 'PER_SQFT', ratePaisa: rs(55), retentionPercent: 5, startDate: '2026-09-15' });

  const measure = async (assignmentId: string, date: string, description: string, quantity: string, verify = true) => {
    const m = await run((tx) => recordMeasurementTx(tx, rafaqat, dha, { assignmentId, date, description, quantity: D(quantity) }, { at: at(date, 17) }));
    if (verify) await run((tx) => verifyMeasurementTx(tx, bilal, m.data.id, { at: at(addDays(date, 1), 10) }));
  };
  await measure(sharif.id, '2026-09-12', 'Ground-floor slab & beams', '4100');
  await measure(sharif.id, '2026-09-30', 'First-floor slab & beams', '4100');
  await measure(sharif.id, '2026-10-04', 'Mumty slab', '650', false); // waiting for verification
  await measure(latif.id, '2026-09-11', 'Footings + ground-floor columns & slab', '8.5');
  await measure(latif.id, '2026-09-29', 'First-floor columns & slab', '5.7');
  await measure(ali.id, '2026-10-01', 'Conduit — ground floor (35% of 3,950 sqft)', '1382.5');
  await run((tx) => progressTx(tx, bilal, haji.id, { percent: 40, date: '2026-09-30', note: 'Ground floor rough-in complete' }, { at: at('2026-09-30', 16) }));

  const subPay = (a: Actor, assignmentId: string, date: string, body: Omit<Parameters<typeof paySubcontractTx>[3], 'date'>) =>
    run((tx) => paySubcontractTx(tx, a, assignmentId, { date, ...body }, { at: at(date, 12) }));
  await subPay(khalid, sharif.id, '2026-09-20', { type: 'RUNNING', amountPaisa: rs(150000), paidFrom: 'BANK', reference: 'HBL-2201' });
  await subPay(khalid, sharif.id, '2026-10-03', { type: 'RUNNING', amountPaisa: rs(170000), paidFrom: 'BANK', reference: 'HBL-2240' });
  await run((tx) =>
    createAdvanceTx(tx, khalid, dha, { payeeType: 'SUBCONTRACTOR', assignmentId: latif.id, amountPaisa: rs(25000), date: '2026-09-05', paidFrom: 'OFFICE_CASH', note: 'Mobilisation' }, { at: at('2026-09-05', 12) }),
  );
  await subPay(khalid, latif.id, '2026-09-20', { type: 'RUNNING', amountPaisa: rs(70000), paidFrom: 'BANK', reference: 'HBL-2202', allowAdvance: true });
  await subPay(khalid, latif.id, '2026-10-01', { type: 'RUNNING', amountPaisa: rs(50000), paidFrom: 'OFFICE_CASH', allowAdvance: true, note: 'Asked for extra before Eid' });
  await subPay(khalid, haji.id, '2026-10-01', { type: 'RUNNING', amountPaisa: rs(30000), paidFrom: 'JAZZCASH', reference: 'JC-5512' });
  await subPay(khalid, ali.id, '2026-10-02', { type: 'RUNNING', amountPaisa: rs(60000), paidFrom: 'BANK', reference: 'HBL-2236', allowAdvance: true });

  // ─── Rafaqat: count, float, kharcha, top-up ────────────────────────────
  await run((tx) => createCountTx(tx, rafaqat, { countedPaisa: rs(6800), note: 'Change to tea boy' }, { at: at('2026-09-28', 18) }));
  const float = await run((tx) =>
    sendFloatTx(tx, khalid, { holderUserId: s.rafaqatId, amountPaisa: rs(50000), method: 'EASYPAISA', reference: 'EP88213', projectId: dha }, { at: at('2026-10-01', 9) }),
  );
  await run((tx) => acknowledgeTx(tx, rafaqat, float.id, { at: at('2026-10-01', 9, 40) }));
  const kharcha = (a: Actor, projectId: string, date: string, hour: number, body: Omit<ExpenseInput, 'projectId' | 'date'>) =>
    run((tx) => createExpenseTx(tx, a, { projectId, date, ...body }, { at: at(date, hour) }));
  await kharcha(rafaqat, dha, '2026-10-01', 11, { category: 'TEA_WATER', amountPaisa: rs(1200), description: 'Chai & water for the labour (week)' });
  await kharcha(rafaqat, dha, '2026-10-02', 9, { category: 'FUEL', amountPaisa: rs(5650), description: 'Diesel for the mixer' });
  await kharcha(rafaqat, dha, '2026-10-02', 13, { category: 'TRANSPORT', amountPaisa: rs(2500), description: 'Rickshaw — shuttering props from the yard' });
  await kharcha(rafaqat, dha, '2026-10-02', 17, { category: 'UNLOADING', amountPaisa: rs(3000), description: 'Unloading sand trolley' });
  await kharcha(rafaqat, dha, '2026-10-03', 10, { category: 'URGENT_MATERIAL', amountPaisa: rs(4350), description: 'PPR fittings — plumber waiting' });
  const sand = await kharcha(rafaqat, dha, '2026-10-03', 15, { category: 'URGENT_MATERIAL', amountPaisa: rs(28000), description: 'Sand trolley — slab casting could not wait' });
  // Above the kharcha limit (Rs 25,000 by default) it waits for approval — Bilal approves it.
  if (sand.data.status === 'PENDING_APPROVAL') await run((tx) => approveExpenseTx(tx, bilal, sand.data.id, 'Checked at site', { at: at('2026-10-04', 10) }));
  await kharcha(rafaqat, dha, '2026-10-04', 12, { category: 'OWNER_PURCHASE', amountPaisa: rs(2800), description: 'Tile samples for the owner (Mrs. Hina)' });
  await run((tx) => requestTopupTx(tx, rafaqat, { amountPaisa: rs(40000), note: 'Wages on Saturday + cement unloading' }, { at: at('2026-10-05', 16) }));

  // ─── Asif (Bahria): float 75,000, spent 53,500 ─────────────────────────
  const asifFloat = await run((tx) =>
    sendFloatTx(tx, khalid, { holderUserId: s.asifId, amountPaisa: rs(75000), method: 'BANK', reference: 'IBFT-77120', projectId: bahria }, { at: at('2026-09-29', 10) }),
  );
  await run((tx) => acknowledgeTx(tx, asif, asifFloat.id, { at: at('2026-09-29', 12) }));
  await kharcha(asif, bahria, '2026-09-30', 11, { category: 'TRANSPORT', amountPaisa: rs(8500), description: 'Loader rickshaw — excavation debris' });
  await kharcha(asif, bahria, '2026-10-01', 12, { category: 'UNLOADING', amountPaisa: rs(6000), description: 'Unloading bricks (12,000)' });
  await kharcha(asif, bahria, '2026-10-02', 10, { category: 'FUEL', amountPaisa: rs(4000), description: 'Generator diesel' });
  await kharcha(asif, bahria, '2026-10-03', 15, { category: 'SMALL_TOOLS', amountPaisa: rs(3000), description: 'Shovels, buckets, tasla' });
  await kharcha(asif, bahria, '2026-10-05', 13, { category: 'REPAIRS', amountPaisa: rs(32000), description: 'Water pump motor rewinding' }); // above the limit → waits
}

