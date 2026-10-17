/**
 * Step 14 · the APPROVED estimate as the control views need it: line amounts by stage and cost
 * bucket, and per material the estimate rate per material unit (Σ amount ÷ Σ quantity converted to
 * the material's unit, contractor lines only) and the estimated quantity. Money stays internal —
 * services decide what a caller may see.
 */
import type { Tx } from '../../core/db/withTenant.js';
import type { EstimateLineKind, SuppliedBy } from '../../generated/prisma/client.js';
import { toBaseUnit } from '../estimate/engine.js';

/** Cost-variance buckets. */
export const CONTROL_BUCKETS = ['MATERIALS', 'LABOUR', 'SUBCONTRACT', 'EQUIPMENT', 'OVERHEADS', 'LOSSES', 'CONTINGENCY'] as const;
export type ControlBucket = (typeof CONTROL_BUCKETS)[number];

export interface EstLine {
  stageKey: string | null;
  section: string;
  kind: EstimateLineKind;
  suppliedBy: SuppliedBy;
  materialId: string | null;
  material: string | null;
  unit: string;
  quantity: number;
  amountPaisa: bigint | null;
  bucket: ControlBucket;
}

export interface MaterialRate {
  /** paisa per material unit (fractional) */
  ratePaisa: number;
  /** estimated quantity in the material unit (contractor + owner lines that convert) */
  quantity: number;
}

export interface EstimateData {
  id: string;
  revision: number;
  totalPaisa: bigint;
  lines: EstLine[];
  /** stage key → Σ contractor line amounts (weights for physical progress) */
  stageValues: Map<string, bigint>;
  /** material id → estimate rate per material unit (contractor lines with an amount) */
  rates: Map<string, MaterialRate>;
}

/** Estimate line → cost bucket. */
export function bucketOfLine(l: Pick<EstLine, 'kind' | 'section'>): ControlBucket {
  if (l.section === 'SITE_OVERHEADS') return 'OVERHEADS';
  if (l.section === 'CONTINGENCY') return 'CONTINGENCY';
  if (l.section === 'EQUIPMENT_SHUTTERING') return 'EQUIPMENT';
  if (l.kind === 'MATERIAL') return 'MATERIALS';
  if (l.kind === 'LABOUR') return 'LABOUR';
  if (l.kind === 'PERCENT') return 'OVERHEADS';
  return 'SUBCONTRACT'; // LUMP_SUM: MEP rough-in, excavation … usually given on theka
}

export async function loadApprovedEstimate(tx: Tx, tenantId: string, projectId: string): Promise<EstimateData | null> {
  const e = await tx.estimate.findFirst({ where: { tenantId, projectId, status: 'APPROVED' }, select: { id: true, revision: true, totalPaisa: true } });
  if (!e) return null;
  const rows = await tx.estimateLine.findMany({
    where: { tenantId, estimateId: e.id },
    select: { stageKey: true, section: true, kind: true, suppliedBy: true, materialId: true, material: true, unit: true, quantityWithWastage: true, overrideQuantity: true, amountPaisa: true },
    orderBy: { sortOrder: 'asc' },
  });
  const lines: EstLine[] = rows.map((l) => {
    const line = {
      stageKey: l.stageKey,
      section: l.section,
      kind: l.kind,
      suppliedBy: l.suppliedBy,
      materialId: l.materialId,
      material: l.material,
      unit: l.unit,
      quantity: Number(l.overrideQuantity ?? l.quantityWithWastage),
      amountPaisa: l.suppliedBy === 'CONTRACTOR' ? l.amountPaisa : null,
    };
    return { ...line, bucket: bucketOfLine(line) };
  });

  const stageValues = new Map<string, bigint>();
  for (const l of lines) {
    if (!l.stageKey || l.kind === 'PERCENT' || l.amountPaisa === null) continue;
    stageValues.set(l.stageKey, (stageValues.get(l.stageKey) ?? 0n) + l.amountPaisa);
  }

  const ids = [...new Set(lines.filter((l) => l.kind === 'MATERIAL' && l.materialId).map((l) => l.materialId!))];
  const mats = ids.length ? await tx.material.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, unit: true, altUnits: true } }) : [];
  const matOf = new Map(mats.map((m) => [m.id, m]));
  const acc = new Map<string, { amount: bigint; pricedQty: number; qty: number }>();
  for (const l of lines) {
    if (l.kind !== 'MATERIAL' || !l.materialId) continue;
    const m = matOf.get(l.materialId);
    if (!m) continue;
    const qty = toBaseUnit(l.quantity, l.unit, m.unit, (m.altUnits ?? []) as Array<{ unit: string; factor: number }>);
    if (qty === null) continue;
    const a = acc.get(l.materialId) ?? { amount: 0n, pricedQty: 0, qty: 0 };
    a.qty += qty;
    if (l.amountPaisa !== null && qty > 0) {
      a.amount += l.amountPaisa;
      a.pricedQty += qty;
    }
    acc.set(l.materialId, a);
  }
  const rates = new Map<string, MaterialRate>();
  for (const [id, a] of acc) if (a.pricedQty > 0) rates.set(id, { ratePaisa: Number(a.amount) / a.pricedQty, quantity: a.qty });

  return { id: e.id, revision: e.revision, totalPaisa: e.totalPaisa, lines, stageValues, rates };
}
