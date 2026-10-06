/**
 * Shortages: differences found when a delivery was counted. Each stays OPEN until the owner
 * decides what happens:
 *   SEND_REMAINING      — dispatch the missing quantity again from the same source
 *   RETURN_TO_STORE     — short / damaged goods go back to the source (excess: back from the site)
 *   ACCEPT_LOSS         — the loss (or the excess) is accepted as is
 *   RECOVER_FROM_DRIVER — the driver pays; the amount is recorded
 *   SUPPLIER_CREDIT     — purchase shortages: the supplier's ledger is credited with the value
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import type { Prisma, ShortageResolution } from '../../generated/prisma/client.js';
import { actor, audit, avgOf, balanceOf, lockLocations, materialRef, postIn, postOut, qn, type Actor } from '../inventory/stock.js';
import { chargeShortageToAssignment } from '../labor/subcontracts.service.js';
import { postLedger } from '../procurement/supplierLedger.service.js';
import { projectScope } from '../projects/access.js';
import type { ListShortagesQuery, ResolveShortageInput } from './dispatch.schema.js';
import { writeDispatch } from './dispatches.service.js';

const shortageInclude = {
  material: { select: { id: true, name: true, unit: true } },
  location: { select: { id: true, type: true, name: true, projectId: true } },
  project: { select: { id: true, code: true, name: true } },
  dispatch: { select: { id: true, number: true, fromLocationId: true, toLocationId: true, vehicleNo: true, driverName: true, driverPhone: true } },
  purchase: { select: { id: true, number: true, challanNo: true, supplier: { select: { id: true, name: true } } } },
  newDispatch: { select: { id: true, number: true } },
  resolvedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.ShortageInclude;

type ShortageRow = Prisma.ShortageGetPayload<{ include: typeof shortageInclude }>;

function toShortageDto(s: ShortageRow, a: Pick<Actor, 'seesRates'>) {
  return {
    id: s.id,
    kind: s.kind,
    source: s.source,
    status: s.status,
    material: materialRef(s.material),
    qty: qn(s.qty),
    ...(a.seesRates ? { valuePaisa: s.valuePaisa.toString() } : {}),
    location: s.location,
    project: s.project,
    dispatch: s.dispatch ? { id: s.dispatch.id, number: s.dispatch.number, vehicleNo: s.dispatch.vehicleNo, driverName: s.dispatch.driverName, driverPhone: s.dispatch.driverPhone } : null,
    purchase: s.purchase,
    note: s.note,
    allowedResolutions: allowedFor(s),
    resolution: s.resolution,
    resolutionNote: s.resolutionNote,
    ...(a.seesRates ? { recoveredAmountPaisa: s.recoveredAmountPaisa?.toString() ?? null } : {}),
    newDispatch: s.newDispatch,
    resolvedBy: s.resolvedBy,
    resolvedAt: s.resolvedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

export function allowedFor(s: Pick<ShortageRow, 'kind' | 'source'>): ShortageResolution[] {
  if (s.source === 'PURCHASE') return ['SUPPLIER_CREDIT', 'ACCEPT_LOSS'];
  if (s.kind === 'EXCESS') return ['RETURN_TO_STORE', 'ACCEPT_LOSS'];
  return ['SEND_REMAINING', 'RETURN_TO_STORE', 'ACCEPT_LOSS', 'RECOVER_FROM_DRIVER'];
}

/** THEKEDAR all; PM the shortages of their projects (read only). */
function scope(a: Actor): Prisma.ShortageWhereInput {
  return a.role === 'THEKEDAR' ? {} : { project: projectScope(a) };
}

export async function listShortages(query: ListShortagesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const where: Prisma.ShortageWhereInput = { tenantId: a.tenantId, ...scope(a) };
    if (query.status) where.status = query.status;
    if (query.kind) where.kind = query.kind;
    if (query.source) where.source = query.source;
    if (query.projectId) where.projectId = query.projectId;
    const rows = await tx.shortage.findMany({ where, include: shortageInclude, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.shortage.count({ where });
    const open = await tx.shortage.aggregate({ where: { tenantId: a.tenantId, ...scope(a), status: 'OPEN' }, _count: { _all: true }, _sum: { valuePaisa: true } });
    return {
      data: rows.map((s) => toShortageDto(s, a)),
      meta: { ...pageMeta(query, total), openCount: open._count._all, ...(a.seesRates ? { openValuePaisa: (open._sum.valuePaisa ?? 0n).toString() } : {}) },
    };
  });
}

export async function resolveShortageTx(tx: Tx, a: Actor, id: string, input: ResolveShortageInput, opts: { at?: Date } = {}) {
  const s = await tx.shortage.findFirst({ where: { tenantId: a.tenantId, id }, include: shortageInclude });
  if (!s) throw new NotFound('SHORTAGE_NOT_FOUND', 'Shortage not found');
  if (s.status !== 'OPEN') throw new Conflict('SHORTAGE_RESOLVED', 'This shortage has already been resolved', { resolution: s.resolution });
  if (!allowedFor(s).includes(input.resolution)) {
    throw new BadRequest('RESOLUTION_NOT_ALLOWED', `${input.resolution.replaceAll('_', ' ').toLowerCase()} doesn’t apply to this shortage`, { allowed: allowedFor(s) });
  }
  const at = opts.at ?? new Date();
  const unitCost = avgOf(s.qty, s.valuePaisa);
  const ref = { refType: 'SHORTAGE', refId: s.id, occurredAt: at, createdById: a.userId, note: input.note };
  let newDispatchId: string | null = null;

  switch (input.resolution) {
    case 'SEND_REMAINING': {
      const d = s.dispatch!;
      const from = await tx.stockLocation.findUniqueOrThrow({ where: { id: d.fromLocationId } });
      const to = await tx.stockLocation.findUniqueOrThrow({ where: { id: d.toLocationId } });
      const dispatch = await writeDispatch(tx, a, {
        from,
        to,
        items: [{ materialId: s.materialId, qty: s.qty }],
        vehicleNo: input.vehicleNo ?? d.vehicleNo,
        driverName: input.driverName ?? d.driverName,
        driverPhone: input.driverPhone ?? d.driverPhone,
        note: `Remaining from ${d.number}: ${input.note}`,
        at,
      });
      newDispatchId = dispatch.id;
      break;
    }
    case 'RETURN_TO_STORE': {
      const d = s.dispatch!;
      if (s.kind === 'EXCESS') {
        // The extra goods counted at the site go back to where the dispatch came from.
        await lockLocations(tx, [d.toLocationId, d.fromLocationId]);
        const bucket = { locationId: d.toLocationId, materialId: s.materialId, ownerSupplied: false };
        const bal = await balanceOf(tx, a.tenantId, bucket);
        if (bal.qty.lt(s.qty)) throw new BadRequest('INSUFFICIENT_STOCK', 'The site no longer has the extra quantity', { materialId: s.materialId, available: qn(bal.qty) });
        const out = await postOut(tx, a.tenantId, bucket, s.qty, { ...ref, type: 'CORRECTION' }, undefined, s.valuePaisa);
        await postIn(tx, a.tenantId, { locationId: d.fromLocationId, materialId: s.materialId, ownerSupplied: false }, s.qty, out.unitCostPaisa, { ...ref, type: 'CORRECTION' }, out.valuePaisa);
      } else {
        // The goods never really left (or came back on the truck): they are counted back in at the source.
        await lockLocations(tx, [d.fromLocationId]);
        await postIn(tx, a.tenantId, { locationId: d.fromLocationId, materialId: s.materialId, ownerSupplied: false }, s.qty, unitCost, { ...ref, type: 'CORRECTION' }, s.valuePaisa);
      }
      break;
    }
    case 'SUPPLIER_CREDIT': {
      await postLedger(tx, a, {
        supplierId: s.purchase!.supplier.id,
        type: 'ADJUSTMENT',
        amountPaisa: -s.valuePaisa,
        refType: 'SHORTAGE',
        refId: s.id,
        projectId: s.projectId,
        occurredAt: at,
        note: `${s.purchase!.number}: ${qn(s.qty)} ${s.material.unit} ${s.material.name} short — ${input.note}`,
      });
      break;
    }
    case 'ACCEPT_LOSS':
      if (input.chargeToAssignmentId) {
        if (a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', 'Only the owner can charge a loss to a sub-contractor');
        await chargeShortageToAssignment(tx, a, {
          assignmentId: input.chargeToAssignmentId,
          projectId: s.projectId,
          shortageId: s.id,
          amountPaisa: s.valuePaisa,
          note: `${qn(s.qty)} ${s.material.unit} ${s.material.name} — ${input.note}`,
        });
      }
      break;
    case 'RECOVER_FROM_DRIVER':
      // No stock movement: the loss stays where the count put it. Cash recovered is recorded here
      // (the cash book, Phase 1 · Step 7, will post it).
      break;
  }

  await tx.shortage.update({
    where: { id },
    data: {
      status: 'RESOLVED',
      resolution: input.resolution,
      resolutionNote: input.note,
      recoveredAmountPaisa: input.resolution === 'RECOVER_FROM_DRIVER' ? input.recoveredAmountPaisa! : null,
      newDispatchId,
      resolvedById: a.userId,
      resolvedAt: at,
    },
  });
  await audit(tx, a, 'shortage.resolve', 'Shortage', id, {
    kind: s.kind,
    resolution: input.resolution,
    note: input.note,
    qty: qn(s.qty),
    valuePaisa: s.valuePaisa.toString(),
    ...(input.recoveredAmountPaisa !== undefined ? { recoveredAmountPaisa: input.recoveredAmountPaisa.toString() } : {}),
    ...(input.chargeToAssignmentId ? { chargedToAssignmentId: input.chargeToAssignmentId } : {}),
  });
  return toShortageDto(await tx.shortage.findUniqueOrThrow({ where: { id }, include: shortageInclude }), a);
}

export async function resolveShortage(id: string, input: ResolveShortageInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => resolveShortageTx(tx, a, id, input));
}
