/**
 * Malik & Sons closeout demo (Step 17), CLI seed only (runs with the billing demo):
 *   - DHA Phase 6 (ACTIVE): drawings in four folders — the ground floor plan and the structural
 *     layout each have 2 revisions (R0 superseded, R1 latest); two snags, one charged to Ustad
 *     Sharif's sub-contract (DEDUCTION on his account).
 *   - Johar Town (moved to CLOSEOUT): snag list in every status (overdue OPEN, FIXED with an after
 *     photo, VERIFIED with a REWORK cost, OPEN with the plumber), a final drawing and a partly
 *     filled handover checklist (no owner sign-off yet).
 *   - Valencia (HANDED_OVER): handover recorded ~6 months ago → retention due in 10 days, one
 *     defect-period snag.
 * Skipped when the company already has drawings.
 */
import { dateOnly, todayIn } from '../src/core/utils/dates.js';
import { uuidv7 } from '../src/core/utils/uuid.js';
import type { DrawingFolder, HandoverItemKey, PrismaClient } from '../src/generated/prisma/client.js';
import { storage } from '../src/modules/attachments/storage.provider.js';
import { addMonths } from '../src/modules/closeout/closeout.shared.js';
import { addDays } from '../src/modules/labor/labor.shared.js';
import { solidPng } from './seedDailyLogs.js';

export interface CloseoutSeedInput {
  tenantId: string;
  ownerId: string;
  bilalId: string;
  rafaqatId: string;
  projects: { dha: { id: string }; johar: { id: string }; valencia: { id: string } };
}

const PKT = 'Asia/Karachi';
const at = (day: string, hour = 10) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+05:00`);

/** A one-page PDF with a title (a stand-in for a drawing sheet). */
function tinyPdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 60 760 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export async function seedMalikCloseout(db: PrismaClient, s: CloseoutSeedInput, now = new Date()): Promise<{ skipped: boolean }> {
  if (await db.drawing.count({ where: { tenantId: s.tenantId } })) return { skipped: true };
  const today = todayIn(PKT, now);
  const day = (n: number) => addDays(today, -n);

  const store = async (buf: Buffer, ext: 'pdf' | 'png', mime: string, kind: 'DOCUMENT' | 'SITE_PHOTO', name: string, by: string) => {
    const id = uuidv7();
    let key = `${s.tenantId}/${today.slice(0, 4)}/${today.slice(5, 7)}/${id}.${ext}`;
    try {
      key = await storage().put(key, buf, mime);
    } catch {
      // keep the key; only the preview is missing
    }
    await db.attachment.create({ data: { id, tenantId: s.tenantId, kind, storageKey: key, fileName: name, mimeType: mime, sizeBytes: buf.length, uploadedById: by } });
    return id;
  };
  const sheet = (title: string) => store(tinyPdf(title), 'pdf', 'application/pdf', 'DOCUMENT', `${title}.pdf`, s.ownerId);
  const photo = (color: [number, number, number], name: string) => store(solidPng(320, 240, color), 'png', 'image/png', 'SITE_PHOTO', name, s.rafaqatId);

  // ─── Drawings ─────────────────────────────────────────────────────────────
  const drawing = async (projectId: string, folder: DrawingFolder, title: string, number: string, revisions: Array<{ approvedAt: string | null; notes: string; day: string }>) => {
    const d = await db.drawing.create({ data: { tenantId: s.tenantId, projectId, folder, title, number, createdById: s.ownerId, createdAt: at(revisions[0]!.day) } });
    for (const [i, r] of revisions.entries()) {
      await db.drawingRevision.create({
        data: {
          tenantId: s.tenantId,
          drawingId: d.id,
          revisionNo: i,
          attachmentId: await sheet(`${number} R${i} ${title}`),
          approvedAt: r.approvedAt ? dateOnly(r.approvedAt) : null,
          notes: r.notes,
          isLatest: i === revisions.length - 1,
          uploadedById: s.ownerId,
          createdAt: at(r.day),
        },
      });
    }
    return d;
  };
  const dha = s.projects.dha.id;
  await drawing(dha, 'ARCHITECTURAL', 'Ground floor plan', 'A-101', [
    { approvedAt: '2026-03-02', notes: 'Society approved set', day: '2026-03-02' },
    { approvedAt: '2026-06-18', notes: 'Kitchen window moved 2 ft east, store enlarged', day: '2026-06-18' },
  ]);
  await drawing(dha, 'STRUCTURAL', 'Foundation & column layout', 'S-201', [
    { approvedAt: '2026-03-05', notes: 'Strip footing, 12 × 12 columns', day: '2026-03-05' },
    { approvedAt: '2026-04-02', notes: 'Columns C7–C9 changed to 12 × 15 after soil report', day: '2026-04-02' },
  ]);
  await drawing(dha, 'MEP', 'Electrical layout — ground floor', 'E-301', [{ approvedAt: null, notes: 'For site use; DB location to be confirmed', day: '2026-08-20' }]);
  await drawing(dha, 'SOCIETY_APPROVED', 'DHA approved building plan', 'DHA-6-214', [{ approvedAt: '2026-02-20', notes: 'Approval letter 2026/BP/1182', day: '2026-02-20' }]);
  await drawing(s.projects.johar.id, 'ARCHITECTURAL', 'As-built plan (final)', 'A-110', [{ approvedAt: day(6), notes: 'Final drawings for the owner', day: day(6) }]);

  // ─── Snags ────────────────────────────────────────────────────────────────
  const worker = (name: string) => db.worker.findFirst({ where: { tenantId: s.tenantId, name: { contains: name } }, select: { id: true } });
  const sub = (name: string) => db.subcontractor.findFirst({ where: { tenantId: s.tenantId, name }, select: { id: true } });
  const room = (projectId: string, name: string) => db.room.findFirst({ where: { tenantId: s.tenantId, projectId, name: { contains: name } }, select: { id: true } });
  const numbers = new Map<string, number>();
  const snag = async (projectId: string, data: Record<string, unknown> & { description: string; createdOn: string }) => {
    const n = (numbers.get(projectId) ?? 0) + 1;
    numbers.set(projectId, n);
    const { createdOn, ...rest } = data;
    return db.snag.create({ data: { tenantId: s.tenantId, projectId, number: n, createdById: s.rafaqatId, createdAt: at(createdOn, 11), ...rest } as never });
  };

  const sharif = await sub('Ustad Sharif Shuttering');
  const haji = await sub('Haji Plumbing Works');
  const akram = await worker('Akram');
  const saleem = await worker('Saleem');

  // DHA (ACTIVE)
  await snag(dha, {
    roomId: (await room(dha, 'Lounge'))?.id ?? null,
    location: 'Lounge ceiling, near the stair opening',
    description: 'Honeycombing in the slab soffit after de-shuttering',
    beforePhotoIds: [await photo([150, 150, 160], 'Slab honeycomb.png')],
    subcontractorId: sharif?.id ?? null,
    targetDate: dateOnly(day(-5)),
    createdOn: day(3),
  });
  const sharifAssignment = sharif ? await db.subcontractAssignment.findFirst({ where: { tenantId: s.tenantId, projectId: dha, subcontractorId: sharif.id }, select: { id: true } }) : null;
  const bulge = await snag(dha, {
    location: 'First floor — beam B4',
    description: 'Beam side bulged (shuttering moved during the pour)',
    beforePhotoIds: [await photo([120, 110, 100], 'Beam bulge.png')],
    afterPhotoIds: [await photo([200, 200, 200], 'Beam chipped and plastered.png')],
    subcontractorId: sharif?.id ?? null,
    status: 'VERIFIED',
    fixNote: 'Bulge chipped off and plastered',
    fixedAt: at(day(8), 16),
    fixedById: s.rafaqatId,
    verifiedAt: at(day(7), 12),
    verifiedById: s.bilalId,
    ...(sharifAssignment ? { costAttribution: 'SUBCONTRACTOR_DEDUCTION', costAmountPaisa: 450_000n, costAssignmentId: sharifAssignment.id, costNote: 'Shuttering not braced', costPostedAt: at(day(7), 12) } : {}),
    createdOn: day(10),
  });
  if (sharifAssignment) {
    await db.subcontractLedgerEntry.create({
      data: { tenantId: s.tenantId, assignmentId: sharifAssignment.id, type: 'DEDUCTION', amountPaisa: -450_000n, refType: 'SNAG', refId: bulge.id, occurredAt: at(day(7), 12), note: 'Snag SN-002: Shuttering not braced', createdById: s.ownerId },
    });
  }

  // Johar Town → CLOSEOUT
  const johar = s.projects.johar.id;
  await db.project.update({ where: { id: johar }, data: { status: 'CLOSEOUT' } });
  await snag(johar, {
    location: 'Master bathroom',
    description: 'Wall tiles hollow (drummy) behind the basin — 4 tiles',
    beforePhotoIds: [await photo([210, 220, 230], 'Hollow tiles.png')],
    workerId: akram?.id ?? null,
    targetDate: dateOnly(day(2)),
    createdOn: day(9),
  });
  await snag(johar, {
    location: 'Kitchen',
    description: 'Sink waste pipe leaking at the joint',
    beforePhotoIds: [await photo([90, 120, 160], 'Sink leak.png')],
    subcontractorId: haji?.id ?? null,
    targetDate: dateOnly(day(-4)),
    createdOn: day(5),
  });
  await snag(johar, {
    location: 'Main gate',
    description: 'Gate rubbing the floor, does not close fully',
    beforePhotoIds: [await photo([60, 60, 60], 'Gate rubbing.png')],
    afterPhotoIds: [await photo([80, 140, 80], 'Gate adjusted.png')],
    workerId: saleem?.id ?? null,
    status: 'FIXED',
    fixNote: 'Hinges re-welded, 6 mm cleared',
    fixedAt: at(day(1), 15),
    fixedById: s.rafaqatId,
    createdOn: day(4),
  });
  await snag(johar, {
    location: 'Bedroom 2',
    description: 'Paint patchy on the north wall after the seepage repair',
    beforePhotoIds: [await photo([230, 200, 160], 'Patchy paint.png')],
    afterPhotoIds: [await photo([240, 240, 235], 'Repainted.png')],
    workerId: akram?.id ?? null,
    status: 'VERIFIED',
    fixNote: 'Two coats on the whole wall',
    fixedAt: at(day(6), 17),
    fixedById: s.rafaqatId,
    verifiedAt: at(day(5), 11),
    verifiedById: s.bilalId,
    costAttribution: 'REWORK',
    costAmountPaisa: 1_200_000n,
    costNote: 'Paint + 2 days painter',
    costPostedAt: at(day(5), 11),
    createdOn: day(12),
  });
  const handover = await db.projectHandover.create({ data: { tenantId: s.tenantId, projectId: johar } });
  const done: Array<[HandoverItemKey, boolean, string | null]> = [
    ['KEYS', true, '3 sets — main gate, front door, store'],
    ['ELECTRICITY_CONNECTION', true, 'LESCO meter installed, reference 24 11234 5678901'],
    ['GAS_CONNECTION', false, 'SNGPL demand notice paid, meter awaited'],
    ['WATER_CONNECTION', true, 'WASA connection + overhead tank cleaned'],
    ['WARRANTY_CARDS', false, null],
    ['FINAL_DRAWINGS', true, 'As-built plan A-110'],
    ['FINAL_PHOTOS', false, null],
  ];
  for (const [key, isDone, note] of done) {
    await db.handoverItem.create({ data: { tenantId: s.tenantId, handoverId: handover.id, key, done: isDone, note, doneAt: isDone ? at(day(2)) : null, doneById: isDone ? s.bilalId : null } });
  }

  // Valencia (HANDED_OVER): defect period ends in 10 days.
  const valencia = await db.project.findUniqueOrThrow({ where: { id: s.projects.valencia.id }, select: { id: true, defectPeriodMonths: true } });
  const due = addDays(today, 10);
  const handedOver = addMonths(due, -valencia.defectPeriodMonths);
  const valenciaHandover = await db.projectHandover.create({
    data: {
      tenantId: s.tenantId,
      projectId: valencia.id,
      ownerName: 'Tariq Mehmood',
      signedOn: dateOnly(handedOver),
      signOffRecordedAt: at(handedOver, 16),
      signOffRecordedById: s.ownerId,
      handedOverAt: dateOnly(handedOver),
      defectPeriodMonths: valencia.defectPeriodMonths,
      retentionDueDate: dateOnly(due),
      reminderDaysBefore: 14,
    },
  });
  for (const key of ['KEYS', 'ELECTRICITY_CONNECTION', 'GAS_CONNECTION', 'WATER_CONNECTION', 'WARRANTY_CARDS', 'FINAL_DRAWINGS', 'FINAL_PHOTOS'] as const) {
    await db.handoverItem.create({ data: { tenantId: s.tenantId, handoverId: valenciaHandover.id, key, done: true, doneAt: at(handedOver), doneById: s.ownerId } });
  }
  await snag(valencia.id, {
    location: 'Roof',
    description: 'Seepage mark on the top-floor ceiling after rain',
    beforePhotoIds: [await photo([170, 160, 140], 'Seepage.png')],
    inDefectPeriod: true,
    targetDate: dateOnly(addDays(today, 7)),
    createdOn: day(2),
  });
  return { skipped: false };
}
