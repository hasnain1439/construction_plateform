/**
 * Step 15 · Change orders — caller, money visibility, loading + DTOs, rates and line maths.
 *
 * Money visibility (keys absent without the field permission):
 *   cost side (line rate / amount, markup %, cost, markup)  fields.rates
 *   owner price (total, line price rate / amount)          fields.rates or fields.amounts
 */
import { assertPerm, fieldAccess, type FieldAccess } from '../../core/auth/access.js';
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { formatDateOnly } from '../../core/utils/dates.js';
import type { ChangeOrderLineKind, ChangeOrderStatus, ChangeOrderType, Project } from '../../generated/prisma/client.js';
import { assertAttachments, attachmentsById, fileOf, lockKey, peopleById, personOf, photosOf } from '../closeout/closeout.shared.js';
import { audit } from '../inventory/stock.js';
import { times } from '../labor/labor.shared.js';
import { currentRates, defaultCategory } from '../master-data/master-data.repository.js';
import { assertProjectScope, caller, type Caller } from '../projects/access.js';
import type { LineInput } from './changeOrders.schema.js';
import { changeOrderCode, siteInstructionCode } from './totals.js';

export { audit, lockKey };

export interface CoActor {
  tenantId: string;
  userId: string;
  role: Caller['role'];
  fields: FieldAccess;
}

export function coActor(): CoActor {
  const c = caller();
  return { tenantId: c.tenantId, userId: c.userId, role: c.role, fields: c.fields ?? fieldAccess() };
}

export const seesCost = (a: { fields: FieldAccess }) => a.fields.rates;
export const seesPrice = (a: { fields: FieldAccess }) => a.fields.rates || a.fields.amounts;

/** Change orders can be created / changed while the project runs (and at closeout). */
export const CO_PROJECT_STATUSES: Project['status'][] = ['ACTIVE', 'CLOSEOUT'];

export const ymd = (d: Date | null | undefined) => (d ? formatDateOnly(d) : null);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const coNotFound = () => new NotFound('CHANGE_ORDER_NOT_FOUND', 'Change order not found');

export function assertCoStatus(co: { status: ChangeOrderStatus }, allowed: ChangeOrderStatus[]) {
  if (!allowed.includes(co.status)) {
    throw new Conflict('INVALID_CHANGE_ORDER_STATUS', `A ${co.status.toLowerCase().replace('_', ' ')} change order can't do this`, { status: co.status, allowed });
  }
}

const include = { lines: { orderBy: { sortOrder: 'asc' } } } as const satisfies Prisma.ChangeOrderInclude;
export type CoRow = Prisma.ChangeOrderGetPayload<{ include: typeof include }>;

/** The change order when its project is in the caller's scope for `perm` (else 404 CHANGE_ORDER_NOT_FOUND). */
export async function findCo(tx: Tx, a: Pick<CoActor, 'tenantId' | 'userId' | 'role'>, id: string, perm: string): Promise<{ co: CoRow; project: Project }> {
  assertPerm(perm, a);
  const co = await tx.changeOrder.findFirst({ where: { tenantId: a.tenantId, id }, include });
  if (!co) throw coNotFound();
  const project = await assertProjectScope(tx, perm, co.projectId, a).catch((err: unknown) => {
    if (err instanceof NotFound) throw coNotFound();
    throw err;
  });
  return { co, project };
}

export const loadCo = (tx: Tx, id: string) => tx.changeOrder.findUniqueOrThrow({ where: { id }, include });

// ─── DTOs ───────────────────────────────────────────────────────────────────

/** Live (not cancelled) invoices carrying each change order. */
export async function invoicesOf(tx: Tx, tenantId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; number: string | null; type: string; status: string }>();
  const rows = await tx.invoiceLine.findMany({
    where: { tenantId, sourceType: 'CHANGE_ORDER', sourceId: { in: ids }, invoice: { status: { not: 'CANCELLED' } } },
    select: { sourceId: true, invoice: { select: { id: true, number: true, type: true, status: true } } },
  });
  return new Map(rows.map((r) => [r.sourceId!, r.invoice]));
}

function lineDto(l: CoRow['lines'][number], a: { fields: FieldAccess }) {
  return {
    id: l.id,
    sortOrder: l.sortOrder,
    kind: l.kind,
    materialId: l.materialId,
    laborRateId: l.laborRateId,
    description: l.description,
    unit: l.unit,
    quantity: Number(l.quantity.toFixed(3)),
    rateSource: l.rateSource,
    ...(seesCost(a) ? { ratePaisa: l.ratePaisa.toString(), amountPaisa: l.amountPaisa.toString() } : {}),
    ...(seesPrice(a) ? { priceRatePaisa: l.priceRatePaisa.toString(), priceAmountPaisa: l.priceAmountPaisa.toString() } : {}),
  };
}

export async function toDtos(tx: Tx, a: { tenantId: string; fields: FieldAccess }, rows: CoRow[]) {
  const people = await peopleById(
    tx,
    a.tenantId,
    rows.flatMap((r) => [r.createdById, r.approvedById]),
  );
  const invoices = await invoicesOf(
    tx,
    a.tenantId,
    rows.map((r) => r.id),
  );
  const msIds = [...new Set(rows.flatMap((r) => r.affectedMilestoneIds))];
  const ms = msIds.length
    ? await tx.milestone.findMany({ where: { tenantId: a.tenantId, id: { in: msIds } }, select: { id: true, key: true, name: true, stage: { select: { stageKey: true } } } })
    : [];
  const msOf = new Map(ms.map((m) => [m.id, { id: m.id, key: m.key, name: m.name, stageKey: m.stage.stageKey }]));
  return rows.map((r) => {
    const cost = r.costPaisa;
    const price = r.totalPaisa < 0n ? -r.totalPaisa : r.totalPaisa;
    return {
      id: r.id,
      projectId: r.projectId,
      number: r.number,
      code: changeOrderCode(r.number),
      title: r.title,
      description: r.description,
      type: r.type,
      status: r.status,
      source: r.source,
      siteInstructionId: r.siteInstructionId,
      snagId: r.snagId,
      daysImpact: r.daysImpact,
      affectedMilestones: r.affectedMilestoneIds.map((id) => msOf.get(id)).filter((m): m is NonNullable<typeof m> => Boolean(m)),
      proofType: r.proofType,
      proofNote: r.proofNote,
      proofCount: r.proofAttachmentIds.length,
      lineCount: r.lines.length,
      billingMode: r.billingMode,
      invoice: invoices.get(r.id) ?? null,
      sentAt: iso(r.sentAt),
      approvedOn: ymd(r.approvedOn),
      approvedAt: iso(r.approvedAt),
      approvedBy: personOf(people, r.approvedById),
      rejectedAt: iso(r.rejectedAt),
      rejectionReason: r.rejectionReason,
      startedAt: iso(r.startedAt),
      completedAt: iso(r.completedAt),
      billedAt: iso(r.billedAt),
      createdBy: personOf(people, r.createdById),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      ...(seesCost(a) ? { markupPercent: Number(r.markupPercent), costPaisa: cost.toString(), markupPaisa: (price - cost).toString() } : {}),
      ...(seesPrice(a) ? { totalPaisa: r.totalPaisa.toString() } : {}),
    };
  });
}

export type ChangeOrderDto = Awaited<ReturnType<typeof toDtos>>[number];

export async function detailDto(tx: Tx, a: { tenantId: string; fields: FieldAccess }, co: CoRow, project: Pick<Project, 'id' | 'code' | 'name' | 'status'>) {
  const [base] = await toDtos(tx, a, [co]);
  const si = co.siteInstructionId ? await tx.siteInstruction.findFirst({ where: { tenantId: a.tenantId, id: co.siteInstructionId } }) : null;
  const snag = co.snagId ? await tx.snag.findFirst({ where: { tenantId: a.tenantId, id: co.snagId }, select: { id: true, number: true, description: true, status: true } }) : null;
  const files = await attachmentsById(tx, a.tenantId, [...co.proofAttachmentIds, ...(si?.photoIds ?? [])]);
  const people = await peopleById(tx, a.tenantId, [si?.createdById]);
  const proofFiles = [];
  for (const id of co.proofAttachmentIds) {
    const f = await fileOf(files.get(id));
    if (f) proofFiles.push(f);
  }
  return {
    ...base!,
    lines: co.lines.map((l) => lineDto(l, a)),
    proofFiles,
    siteInstruction: si
      ? { id: si.id, code: siteInstructionCode(si.number), note: si.note, photos: await photosOf(si.photoIds, files), createdBy: personOf(people, si.createdById), createdAt: si.createdAt.toISOString() }
      : null,
    snag: snag ? { id: snag.id, code: `SN-${String(snag.number).padStart(3, '0')}`, description: snag.description, status: snag.status } : null,
    project: { id: project.id, code: project.code, name: project.name, status: project.status },
  };
}

// ─── Rates ──────────────────────────────────────────────────────────────────

export type RateSource = 'ESTIMATE' | 'PRICE_LIST' | 'LABOUR_RATE' | 'MANUAL';

export interface RateBook {
  estimate: { id: string; revision: number } | null;
  rateOf(materialId: string): { ratePaisa: bigint; source: RateSource } | null;
}

/** Material rates for a project: the APPROVED estimate's frozen rate, else the company price list (default quality). */
export async function rateBook(tx: Tx, tenantId: string, projectId: string): Promise<RateBook> {
  const est = await tx.estimate.findFirst({ where: { tenantId, projectId, status: 'APPROVED' }, select: { id: true, revision: true, ratesSnapshot: true } });
  const fromEstimate = new Map<string, bigint>();
  const snap = (est?.ratesSnapshot ?? {}) as { materials?: Array<{ materialId?: string | null; ratePaisa?: string | null }> };
  for (const m of snap.materials ?? []) if (m.materialId && m.ratePaisa) fromEstimate.set(m.materialId, BigInt(m.ratePaisa));
  const category = await defaultCategory(tx);
  const priceList = new Map(category ? (await currentRates(tx, tenantId, category.id)).map((r) => [r.materialId, BigInt(r.ratePaisa)]) : []);
  return {
    estimate: est ? { id: est.id, revision: est.revision } : null,
    rateOf(materialId) {
      const e = fromEstimate.get(materialId);
      if (e !== undefined) return { ratePaisa: e, source: 'ESTIMATE' };
      const p = priceList.get(materialId);
      return p !== undefined ? { ratePaisa: p, source: 'PRICE_LIST' } : null;
    },
  };
}

/** rate × (1 + markup %), half-up to paisa. */
export const priceRateOf = (ratePaisa: bigint, markup: Prisma.Decimal) =>
  BigInt(new Prisma.Decimal(ratePaisa.toString()).mul(markup.add(100)).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));

export interface LineRow {
  kind: ChangeOrderLineKind;
  materialId: string | null;
  laborRateId: string | null;
  description: string;
  unit: string;
  quantity: Prisma.Decimal;
  ratePaisa: bigint;
  rateSource: RateSource;
  amountPaisa: bigint;
  priceRatePaisa: bigint;
  priceAmountPaisa: bigint;
}

const incomplete = (i: number, what: string) => new BadRequest('LINE_INCOMPLETE', `Line ${i + 1}: ${what}`, { line: i });

/**
 * Lines → rows with rates and amounts. An explicit `ratePaisa` needs fields.rates unless `trusted`
 * (defaults made by the server, e.g. a snag's amount).
 */
export async function buildLines(tx: Tx, a: Pick<CoActor, 'tenantId' | 'userId' | 'role'>, projectId: string, inputs: LineInput[], markup: Prisma.Decimal, opts: { trusted?: boolean } = {}): Promise<LineRow[]> {
  if (!opts.trusted && inputs.some((l) => l.ratePaisa !== undefined)) assertPerm('fields.rates', a, 'Setting a rate needs the "See rates" permission');
  const book = inputs.some((l) => l.kind === 'MATERIAL' && l.ratePaisa === undefined) ? await rateBook(tx, a.tenantId, projectId) : null;
  const materialIds = [...new Set(inputs.map((l) => l.materialId).filter((x): x is string => Boolean(x)))];
  const labourIds = [...new Set(inputs.map((l) => l.laborRateId).filter((x): x is string => Boolean(x)))];
  const materials = new Map(
    (materialIds.length ? await tx.material.findMany({ where: { tenantId: a.tenantId, id: { in: materialIds } }, select: { id: true, name: true, unit: true } }) : []).map((m) => [m.id, m]),
  );
  const labour = new Map(
    (labourIds.length ? await tx.laborRate.findMany({ where: { tenantId: a.tenantId, id: { in: labourIds } }, select: { id: true, label: true, unit: true, ratePaisa: true } }) : []).map((r) => [r.id, r]),
  );
  return inputs.map((l, i) => {
    let description = l.description;
    let unit = l.unit;
    let rate = l.ratePaisa;
    let source: RateSource = 'MANUAL';
    let materialId: string | null = null;
    let laborRateId: string | null = null;
    if (l.kind === 'MATERIAL') {
      if (!l.materialId) throw new BadRequest('INVALID_MATERIAL', `Line ${i + 1}: choose the material`, { line: i });
      const m = materials.get(l.materialId);
      if (!m) throw new BadRequest('INVALID_MATERIAL', `Line ${i + 1}: material not found`, { line: i, materialId: l.materialId });
      materialId = m.id;
      description ??= m.name;
      unit ??= m.unit;
      if (rate === undefined) {
        const found = book!.rateOf(m.id);
        if (!found) throw new BadRequest('RATE_MISSING', `Line ${i + 1}: no rate for ${m.name} — enter one or set it in the price list`, { line: i, materialId: m.id });
        rate = found.ratePaisa;
        source = found.source;
      }
    } else if (l.kind === 'LABOUR' && l.laborRateId) {
      const r = labour.get(l.laborRateId);
      if (!r) throw new BadRequest('INVALID_LABOR_RATE', `Line ${i + 1}: labour rate not found`, { line: i, laborRateId: l.laborRateId });
      laborRateId = r.id;
      description ??= r.label;
      unit ??= r.unit.toLowerCase();
      if (rate === undefined) {
        rate = r.ratePaisa;
        source = 'LABOUR_RATE';
      }
    }
    if (!description) throw incomplete(i, 'describe the work');
    if (!unit) throw incomplete(i, 'enter the unit');
    if (rate === undefined) throw incomplete(i, 'enter the rate');
    const priceRate = priceRateOf(rate, markup);
    return {
      kind: l.kind,
      materialId,
      laborRateId,
      description,
      unit,
      quantity: l.quantity,
      ratePaisa: rate,
      rateSource: source,
      amountPaisa: times(l.quantity, rate),
      priceRatePaisa: priceRate,
      priceAmountPaisa: times(l.quantity, priceRate),
    };
  });
}

/** Re-prices stored lines for a new markup (rates unchanged). */
export function repriceLines(lines: CoRow['lines'], markup: Prisma.Decimal): LineRow[] {
  return lines.map((l) => {
    const priceRate = priceRateOf(l.ratePaisa, markup);
    return {
      kind: l.kind,
      materialId: l.materialId,
      laborRateId: l.laborRateId,
      description: l.description,
      unit: l.unit,
      quantity: l.quantity,
      ratePaisa: l.ratePaisa,
      rateSource: l.rateSource as RateSource,
      amountPaisa: l.amountPaisa,
      priceRatePaisa: priceRate,
      priceAmountPaisa: times(l.quantity, priceRate),
    };
  });
}

export function totalsOf(rows: LineRow[], type: ChangeOrderType) {
  const cost = rows.reduce((s, r) => s + r.amountPaisa, 0n);
  const price = rows.reduce((s, r) => s + r.priceAmountPaisa, 0n);
  return { costPaisa: cost, totalPaisa: type === 'DEDUCTION' ? -price : price };
}

export async function writeLines(tx: Tx, tenantId: string, changeOrderId: string, rows: LineRow[]) {
  await tx.changeOrderLine.deleteMany({ where: { tenantId, changeOrderId } });
  if (!rows.length) return;
  await tx.changeOrderLine.createMany({ data: rows.map((r, i) => ({ tenantId, changeOrderId, sortOrder: i + 1, ...r })) });
}

// ─── Validation ─────────────────────────────────────────────────────────────

export async function assertMilestones(tx: Tx, tenantId: string, projectId: string, ids: string[] | undefined) {
  if (!ids?.length) return;
  const unique = [...new Set(ids)];
  const found = await tx.milestone.count({ where: { tenantId, projectId, id: { in: unique } } });
  if (found !== unique.length) throw new BadRequest('INVALID_MILESTONE', 'A milestone is not in this project schedule');
}

export const assertProofFiles = (tx: Tx, tenantId: string, ids: string[] | undefined) => assertAttachments(tx, tenantId, ids, ['SITE_PHOTO', 'DOCUMENT'], 'proof file');

export function assertVerbalNote(proofType: string | null | undefined, proofNote: string | null | undefined) {
  if (proofType === 'VERBAL' && !(proofNote && proofNote.trim().length >= 3)) {
    throw new BadRequest('PROOF_NOTE_REQUIRED', 'Verbal approval needs a note: who agreed, when and where');
  }
}
