/** Material used on a site (USAGE_OUT at average cost; owner-supplied at 0). */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { assertEditable, findProjectFor } from '../projects/access.js';
import type { UsageInput, UsageListQuery } from './inventory.schema.js';
import {
  actor,
  assertAvailable,
  audit,
  isOwnerSupplied,
  loadMaterials,
  lockLocations,
  materialRef,
  occurredAtFor,
  ownerSuppliedCategories,
  postOut,
  qn,
  siteLocation,
  type Actor,
} from './stock.js';

/** Projects where site stock may still change. */
export const STOCK_OPEN_STATUSES = ['ACTIVE', 'CLOSEOUT'] as const;

type UsageRow = Prisma.MaterialUsageGetPayload<{
  include: { items: { include: { material: { select: { id: true; name: true; unit: true } } } }; createdBy: { select: { id: true; name: true } } };
}>;

function toUsageDto(u: UsageRow, a: Pick<Actor, 'seesRates'>) {
  return {
    id: u.id,
    projectId: u.projectId,
    usageDate: formatDateOnly(u.usageDate),
    note: u.note,
    milestoneId: u.milestoneId,
    items: u.items.map((i) => ({
      material: materialRef(i.material),
      qty: qn(i.qty),
      ownerSupplied: i.ownerSupplied,
      ...(a.seesRates ? { valuePaisa: i.valuePaisa.toString() } : {}),
    })),
    ...(a.seesRates ? { totalValuePaisa: u.items.reduce((s, i) => s + i.valuePaisa, 0n).toString() } : {}),
    deviceCreatedAt: u.deviceCreatedAt?.toISOString() ?? null,
    createdBy: u.createdBy,
    createdAt: u.createdAt.toISOString(),
  };
}

const usageInclude = {
  items: { include: { material: { select: { id: true, name: true, unit: true } } } },
  createdBy: { select: { id: true, name: true } },
} as const;

export async function recordUsageTx(tx: Tx, a: Actor, projectId: string, input: UsageInput, opts: { at?: Date } = {}) {
  const project = await findProjectFor(tx, a, projectId);
  assertEditable(project, [...STOCK_OPEN_STATUSES]);
  const location = await siteLocation(tx, a.tenantId, project);
  const at = opts.at ?? occurredAtFor(input.usageDate);
  const materials = await loadMaterials(tx, a.tenantId, input.items.map((i) => i.materialId));
  const ownerCats = await ownerSuppliedCategories(tx, a.tenantId, project.id);
  const lines = input.items.map((i) => ({
    locationId: location.id,
    materialId: i.materialId,
    ownerSupplied: i.ownerSupplied ?? isOwnerSupplied(materials.get(i.materialId)!, ownerCats),
    qty: i.qty,
  }));

  await lockLocations(tx, [location.id]);
  await assertAvailable(tx, a.tenantId, lines, materials);

  const usage = await tx.materialUsage.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      locationId: location.id,
      usageDate: dateOnly(input.usageDate),
      note: input.note ?? null,
      milestoneId: input.milestoneId ?? null,
      deviceCreatedAt: input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null,
      createdById: a.userId,
    },
  });
  for (const line of lines) {
    const out = await postOut(tx, a.tenantId, line, line.qty, { type: 'USAGE_OUT', refType: 'USAGE', refId: usage.id, occurredAt: at, createdById: a.userId });
    await tx.materialUsageItem.create({
      data: { tenantId: a.tenantId, usageId: usage.id, materialId: line.materialId, qty: line.qty, ownerSupplied: line.ownerSupplied, valuePaisa: out.valuePaisa },
    });
  }
  await audit(tx, a, 'stock.usage_record', 'MaterialUsage', usage.id, {
    projectId: project.id,
    usageDate: input.usageDate,
    items: lines.map((l) => ({ materialId: l.materialId, qty: qn(l.qty), ownerSupplied: l.ownerSupplied })),
  });
  return toUsageDto(await tx.materialUsage.findUniqueOrThrow({ where: { id: usage.id }, include: usageInclude }), a);
}

export async function recordUsage(projectId: string, input: UsageInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => recordUsageTx(tx, a, projectId, input));
}

export async function listUsage(projectId: string, query: UsageListQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await findProjectFor(tx, a, projectId);
    const where: Prisma.MaterialUsageWhereInput = { tenantId: a.tenantId, projectId: project.id };
    if (query.from || query.to) where.usageDate = { ...(query.from ? { gte: dateOnly(query.from) } : {}), ...(query.to ? { lte: dateOnly(query.to) } : {}) };
    const rows = await tx.materialUsage.findMany({ where, include: usageInclude, orderBy: [{ usageDate: 'desc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.materialUsage.count({ where });
    return { data: rows.map((u) => toUsageDto(u, a)), meta: pageMeta(query, total) };
  });
}
