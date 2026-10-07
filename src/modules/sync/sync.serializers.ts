/**
 * Sync serializers — the ONE place that decides what a phone may see of each row. They mirror
 * the REST visibility rules: never material rates, purchase amounts, supplier balances,
 * contract values or other people's cash; a MUNSHI never sees sub-contract rates or measured
 * values, and with blind count on he does not see sent / challan quantities until he counts.
 * Wages, peshgi and his own cash are allowed.
 */
import { formatDateOnly } from '../../core/utils/dates.js';
import { UNIT_OF } from '../labor/assignments.service.js';

export interface SyncViewer {
  userId: string;
  role: 'THEKEDAR' | 'PM' | 'MUNSHI';
  /** Company setting: receiving hides expected quantities from a MUNSHI until counted. */
  blindCount: boolean;
}

type Dec = { toFixed(n: number): string } | number | string;
const num = (d: Dec | null | undefined) => (d === null || d === undefined ? null : Number(typeof d === 'object' ? d.toFixed(3) : d));
const day = (d: Date | null | undefined) => (d ? formatDateOnly(d) : null);
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const paisa = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());
const isMunshi = (v: SyncViewer) => v.role === 'MUNSHI';

export const LATE_SYNC_MS = 48 * 3_600_000;
const late = (deviceCreatedAt: Date | null | undefined, createdAt: Date) => Boolean(deviceCreatedAt && createdAt.getTime() - deviceCreatedAt.getTime() > LATE_SYNC_MS);

export const serializeProject = (p: { id: string; code: string; name: string; status: string; siteAddress: string | null; city: string | null; startDate: Date | null; endDate: Date | null }) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  status: p.status,
  siteAddress: p.siteAddress,
  city: p.city,
  startDate: day(p.startDate),
  endDate: day(p.endDate),
});

export const serializeLocation = (l: { id: string; type: string; name: string; projectId: string | null }) => ({ id: l.id, type: l.type, name: l.name, projectId: l.projectId });

export const serializeMaterial = (m: { id: string; name: string; unit: string; groupId: string; supplyCategory: string; isHidden: boolean }) => ({
  id: m.id,
  name: m.name,
  unit: m.unit,
  groupId: m.groupId,
  supplyCategory: m.supplyCategory,
  isHidden: m.isHidden,
});

export const serializeMaterialGroup = (g: { id: string; code: string; name: string; sortOrder: number }) => ({ id: g.id, code: g.code, name: g.name, sortOrder: g.sortOrder });

/** Name only — never phone, balances or rates. */
export const serializeSupplier = (s: { id: string; name: string }) => ({ id: s.id, name: s.name });

export const serializeWorker = (w: { id: string; name: string; type: string; phone: string | null; dailyRatePaisa: bigint; isActive: boolean }) => ({
  id: w.id,
  name: w.name,
  type: w.type,
  phone: w.phone,
  dailyRatePaisa: paisa(w.dailyRatePaisa),
  isActive: w.isActive,
});

export const serializeProjectWorker = (pw: { id: string; projectId: string; workerId: string; dailyRatePaisa: bigint; startDate: Date; endDate: Date | null; isActive: boolean }) => ({
  id: pw.id,
  projectId: pw.projectId,
  workerId: pw.workerId,
  dailyRatePaisa: paisa(pw.dailyRatePaisa),
  startDate: day(pw.startDate),
  endDate: day(pw.endDate),
  isActive: pw.isActive,
});

export const serializeAssignment = (
  s: {
    id: string;
    projectId: string;
    scope: string;
    rateType: string;
    ratePaisa: bigint | null;
    contractValuePaisa: bigint | null;
    retentionPercent: Dec;
    progressPercent: Dec;
    startDate: Date;
    isActive: boolean;
    subcontractor: { id: string; name: string; trade: string };
  },
  v: SyncViewer,
) => ({
  id: s.id,
  projectId: s.projectId,
  subcontractor: { id: s.subcontractor.id, name: s.subcontractor.name, trade: s.subcontractor.trade },
  scope: s.scope,
  rateType: s.rateType,
  unit: UNIT_OF[s.rateType as keyof typeof UNIT_OF] ?? s.rateType.toLowerCase(),
  progressPercent: num(s.progressPercent),
  startDate: day(s.startDate),
  isActive: s.isActive,
  ...(isMunshi(v) ? {} : { ratePaisa: paisa(s.ratePaisa), contractValuePaisa: paisa(s.contractValuePaisa), retentionPercent: num(s.retentionPercent) }),
});

export const serializeAttendance = (r: { id: string; projectId: string; workerId: string; date: Date; status: string; overtimeHours: Dec; note: string | null; clientId: string | null; deviceCreatedAt: Date | null; createdAt: Date }) => ({
  id: r.id,
  projectId: r.projectId,
  workerId: r.workerId,
  date: day(r.date),
  status: r.status,
  overtimeHours: num(r.overtimeHours),
  note: r.note,
  clientId: r.clientId,
  lateSync: late(r.deviceCreatedAt, r.createdAt),
});

export const serializeSettlement = (s: {
  id: string;
  projectId: string;
  weekStart: Date;
  weekEnd: Date;
  status: string;
  grossPaisa: bigint;
  advancePaisa: bigint;
  netPaisa: bigint;
  paidPaisa: bigint;
  returnComment: string | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  lines: Array<{
    id: string;
    workerId: string;
    fullDays: number;
    halfDays: number;
    daysWorked: Dec;
    dailyRatePaisa: bigint;
    overtimeHours: Dec;
    overtimePaisa: bigint;
    grossPaisa: bigint;
    advanceAdjustedPaisa: bigint;
    netPaisa: bigint;
    paymentStatus: string;
    paidFrom: string | null;
  }>;
}) => ({
  id: s.id,
  projectId: s.projectId,
  weekStart: day(s.weekStart),
  weekEnd: day(s.weekEnd),
  status: s.status,
  grossPaisa: paisa(s.grossPaisa),
  advancePaisa: paisa(s.advancePaisa),
  netPaisa: paisa(s.netPaisa),
  paidPaisa: paisa(s.paidPaisa),
  returnComment: s.returnComment,
  submittedAt: iso(s.submittedAt),
  approvedAt: iso(s.approvedAt),
  lines: s.lines.map((l) => ({
    id: l.id,
    workerId: l.workerId,
    fullDays: l.fullDays,
    halfDays: l.halfDays,
    daysWorked: num(l.daysWorked),
    dailyRatePaisa: paisa(l.dailyRatePaisa),
    overtimeHours: num(l.overtimeHours),
    overtimePaisa: paisa(l.overtimePaisa),
    grossPaisa: paisa(l.grossPaisa),
    advanceAdjustedPaisa: paisa(l.advanceAdjustedPaisa),
    netPaisa: paisa(l.netPaisa),
    paymentStatus: l.paymentStatus,
    paidFrom: l.paidFrom,
  })),
});

export const serializeAdvance = (r: { id: string; projectId: string; payeeType: string; workerId: string | null; assignmentId: string | null; amountPaisa: bigint; date: Date; paidFrom: string; note: string | null; clientId: string | null; deviceCreatedAt: Date | null; createdAt: Date }) => ({
  id: r.id,
  projectId: r.projectId,
  payeeType: r.payeeType,
  workerId: r.workerId,
  assignmentId: r.assignmentId,
  amountPaisa: paisa(r.amountPaisa),
  date: day(r.date),
  paidFrom: r.paidFrom,
  note: r.note,
  clientId: r.clientId,
  lateSync: late(r.deviceCreatedAt, r.createdAt),
});

/** No value / rate — a MUNSHI records quantities; the office values them. */
export const serializeMeasurement = (m: { id: string; projectId: string; assignmentId: string; date: Date; description: string; quantity: Dec; unit: string; status: string; note: string | null; attachmentIds: string[]; clientId: string | null; deviceCreatedAt: Date | null; createdAt: Date }) => ({
  id: m.id,
  projectId: m.projectId,
  assignmentId: m.assignmentId,
  date: day(m.date),
  description: m.description,
  quantity: num(m.quantity),
  unit: m.unit,
  status: m.status,
  note: m.note,
  attachmentIds: m.attachmentIds,
  clientId: m.clientId,
  lateSync: late(m.deviceCreatedAt, m.createdAt),
});

export const serializeDispatch = (
  d: {
    id: string;
    number: string;
    status: string;
    toLocationId: string;
    fromLocation: { name: string };
    toLocation: { projectId: string | null };
    vehicleNo: string | null;
    driverName: string | null;
    driverPhone: string | null;
    dispatchedAt: Date;
    receivedAt: Date | null;
    items: Array<{ id: string; materialId: string; sentQty: Dec; receivedQty: Dec | null; damagedQty: Dec | null; note: string | null }>;
  },
  v: SyncViewer,
) => {
  const hide = v.blindCount && isMunshi(v) && d.status === 'ON_THE_WAY';
  return {
    id: d.id,
    number: d.number,
    status: d.status,
    projectId: d.toLocation.projectId,
    toLocationId: d.toLocationId,
    from: d.fromLocation.name,
    vehicleNo: d.vehicleNo,
    driverName: d.driverName,
    driverPhone: d.driverPhone,
    dispatchedAt: iso(d.dispatchedAt),
    receivedAt: iso(d.receivedAt),
    blindCount: hide,
    items: d.items.map((i) => ({ id: i.id, materialId: i.materialId, ...(hide ? {} : { sentQty: num(i.sentQty) }), receivedQty: num(i.receivedQty), damagedQty: num(i.damagedQty), note: i.note })),
  };
};

/** A delivery to a site: supplier name only — never rates, amounts or balances. */
export const serializePurchase = (
  p: {
    id: string;
    number: string;
    status: string;
    projectId: string | null;
    locationId: string;
    challanNo: string;
    vehicleNo: string | null;
    purchaseDate: Date;
    receivedAt: Date | null;
    supplier: { id: string; name: string };
    createdById: string | null;
    items: Array<{ id: string; materialId: string; challanQty: Dec; countedQty: Dec | null; damagedQty: Dec | null; note: string | null }>;
  },
  v: SyncViewer,
) => {
  const hide = v.blindCount && isMunshi(v) && p.status === 'PENDING_RECEIPT';
  return {
    id: p.id,
    number: p.number,
    status: p.status,
    projectId: p.projectId,
    locationId: p.locationId,
    supplier: { id: p.supplier.id, name: p.supplier.name },
    challanNo: p.challanNo,
    vehicleNo: p.vehicleNo,
    purchaseDate: day(p.purchaseDate),
    receivedAt: iso(p.receivedAt),
    mine: p.createdById === v.userId,
    blindCount: hide,
    items: p.items.map((i) => ({ id: i.id, materialId: i.materialId, ...(hide ? {} : { challanQty: num(i.challanQty) }), countedQty: num(i.countedQty), damagedQty: num(i.damagedQty), note: i.note })),
  };
};

export const serializeOwnerDelivery = (d: { id: string; projectId: string; locationId: string; deliveryDate: Date; note: string | null; photoAttachmentIds: string[]; items: Array<{ id: string; materialId: string; qty: Dec }> }) => ({
  id: d.id,
  projectId: d.projectId,
  locationId: d.locationId,
  deliveryDate: day(d.deliveryDate),
  note: d.note,
  photoAttachmentIds: d.photoAttachmentIds,
  items: d.items.map((i) => ({ id: i.id, materialId: i.materialId, quantity: num(i.qty) })),
});

/** Quantities only (the stored value is left out). */
export const serializeUsage = (u: { id: string; projectId: string; locationId: string; usageDate: Date; note: string | null; createdById: string | null; items: Array<{ id: string; materialId: string; qty: Dec }> }) => ({
  id: u.id,
  projectId: u.projectId,
  locationId: u.locationId,
  usageDate: day(u.usageDate),
  note: u.note,
  createdById: u.createdById,
  items: u.items.map((i) => ({ id: i.id, materialId: i.materialId, quantity: num(i.qty) })),
});

export const serializeSiteStock = (s: { locationId: string; materialId: string; quantity: number; ownerQuantity: number }) => ({
  id: `${s.locationId}:${s.materialId}`,
  locationId: s.locationId,
  materialId: s.materialId,
  quantity: s.quantity,
  ownerQuantity: s.ownerQuantity,
});

export const serializeStockCount = (c: { id: string; number: string; locationId: string; countedAt: Date; note: string | null; items: Array<{ id: string; materialId: string; ownerSupplied: boolean; systemQty: Dec; countedQty: Dec; difference: Dec; reason: string | null }> }) => ({
  id: c.id,
  number: c.number,
  locationId: c.locationId,
  countedAt: iso(c.countedAt),
  note: c.note,
  items: c.items.map((i) => ({ id: i.id, materialId: i.materialId, ownerSupplied: i.ownerSupplied, systemQty: num(i.systemQty), countedQty: num(i.countedQty), difference: num(i.difference), reason: i.reason })),
});

export const serializeDailyLog = (l: {
  id: string;
  projectId: string;
  logDate: Date;
  note: string | null;
  conditions: string[];
  workDone: string | null;
  photoAttachmentIds: string[];
  voiceAttachmentIds: string[];
  createdById: string;
  createdBy: { name: string };
  clientId: string | null;
  deviceCreatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: l.id,
  projectId: l.projectId,
  logDate: day(l.logDate),
  note: l.note,
  conditions: l.conditions,
  workDone: l.workDone,
  photoAttachmentIds: l.photoAttachmentIds,
  voiceAttachmentIds: l.voiceAttachmentIds,
  authorId: l.createdById,
  authorName: l.createdBy.name,
  clientId: l.clientId,
  lateSync: late(l.deviceCreatedAt, l.createdAt),
  updatedAt: iso(l.updatedAt),
});

/** The caller's OWN account only (balances are computed by the server). */
export const serializeCashAccount = (a: { id: string; name: string; isActive: boolean }, t: { balancePaisa: bigint; pendingAckPaisa: bigint; pendingApprovalPaisa: bigint; recoverablePaisa: bigint }) => ({
  id: a.id,
  name: a.name,
  isActive: a.isActive,
  balancePaisa: paisa(t.balancePaisa),
  pendingAckPaisa: paisa(t.pendingAckPaisa),
  pendingApprovalPaisa: paisa(t.pendingApprovalPaisa),
  recoverablePaisa: paisa(t.recoverablePaisa),
});

export const serializeCashEntry = (e: {
  id: string;
  accountId: string;
  projectId: string | null;
  type: string;
  amountPaisa: bigint;
  category: string | null;
  description: string;
  status: string;
  method: string | null;
  reference: string | null;
  reviewNote: string | null;
  recoverableFromHolder: boolean;
  attachmentId: string | null;
  clientId: string | null;
  occurredAt: Date;
  deviceCreatedAt: Date | null;
  createdAt: Date;
}) => ({
  id: e.id,
  accountId: e.accountId,
  projectId: e.projectId,
  type: e.type,
  amountPaisa: paisa(e.amountPaisa),
  category: e.category,
  description: e.description,
  status: e.status,
  method: e.method,
  reference: e.reference,
  reviewNote: e.reviewNote,
  recoverableFromHolder: e.recoverableFromHolder,
  attachmentId: e.attachmentId,
  clientId: e.clientId,
  occurredAt: iso(e.occurredAt),
  lateSync: late(e.deviceCreatedAt, e.createdAt),
});

export const serializeTopup = (t: { id: string; accountId: string; amountPaisa: bigint; note: string | null; status: string; decisionNote: string | null; clientId: string | null; createdAt: Date; decidedAt: Date | null }) => ({
  id: t.id,
  accountId: t.accountId,
  amountPaisa: paisa(t.amountPaisa),
  note: t.note,
  status: t.status,
  decisionNote: t.decisionNote,
  clientId: t.clientId,
  createdAt: iso(t.createdAt),
  decidedAt: iso(t.decidedAt),
});

export const serializeSettings = (tenantId: string, s: { blindCountEnabled: boolean; kharchaApprovalLimitPaisa: bigint; workingDays: string[]; settlementWeekStart: string; hoursPerDay: Dec; missingLogAlertTime: string } | null) => ({
  id: tenantId,
  blindCountEnabled: s?.blindCountEnabled ?? true,
  kharchaApprovalLimitPaisa: paisa(s?.kharchaApprovalLimitPaisa ?? 2500000n),
  workingDays: s?.workingDays ?? ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
  settlementWeekStart: s?.settlementWeekStart ?? 'MONDAY',
  hoursPerDay: num(s?.hoursPerDay ?? 8),
  missingLogAlertTime: s?.missingLogAlertTime ?? '18:00',
});

export const serializeHoliday = (h: { id: string; startDate: Date; endDate: Date | null; name: string; type: string }, source: 'PLATFORM' | 'COMPANY') => ({
  id: h.id,
  source,
  startDate: day(h.startDate),
  endDate: day(h.endDate),
  name: h.name,
  type: h.type,
});

export const serializeNotification = (n: { id: string; type: string; severity: string; title: string; body: string; projectId: string | null; refType: string; refId: string; actionUrl: string | null; readAt: Date | null; createdAt: Date }) => ({
  id: n.id,
  type: n.type,
  severity: n.severity,
  title: n.title,
  body: n.body,
  projectId: n.projectId,
  refType: n.refType,
  refId: n.refId,
  actionUrl: n.actionUrl,
  read: n.readAt !== null,
  createdAt: iso(n.createdAt),
});
