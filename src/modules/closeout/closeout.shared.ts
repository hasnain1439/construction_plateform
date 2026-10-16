/** Step 17 · Closeout — shared helpers: caller, files / photos, people, dates. */
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { AttachmentKind } from '../../generated/prisma/client.js';
import { signedUrlFor } from '../attachments/attachments.service.js';
import { actor, audit, today, type Actor } from '../labor/labor.shared.js';

export { actor, audit, today, type Actor };

export const ymd = (d: Date | null | undefined) => (d ? formatDateOnly(d) : null);
export const paisa = (v: bigint) => v.toString();

/** "2026-03-31" + 6 months → "2026-09-30" (the day is clamped to the month's last day). */
export function addMonths(date: string, months: number): string {
  const d = dateOnly(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return formatDateOnly(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))));
}

/** Whole days from `from` to `to` (YYYY-MM-DD), negative when `to` is earlier. */
export const daysBetween = (from: string, to: string) => Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / 86_400_000);

/** Every id must be an attachment of the company of one of `kinds` (400 INVALID_ATTACHMENT). */
export async function assertAttachments(tx: Tx, tenantId: string, ids: string[] | undefined | null, kinds: AttachmentKind[], label: string) {
  if (!ids?.length) return;
  const unique = [...new Set(ids)];
  const found = await tx.attachment.count({ where: { tenantId, id: { in: unique }, kind: { in: kinds } } });
  if (found !== unique.length) throw new BadRequest('INVALID_ATTACHMENT', `A ${label} was not found — upload it again`, { kinds });
}

export interface PhotoDto {
  id: string;
  mimeType: string;
  url: string;
  thumbUrl: string;
}

export interface FileDto {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  thumbUrl: string | null;
  expiresAt: string;
}

type AttRow = { id: string; storageKey: string; mimeType: string; fileName: string; sizeBytes: number };

/** Loads the attachments once (ordered as asked, missing ones dropped). */
export async function attachmentsById(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, AttRow>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await tx.attachment.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, storageKey: true, mimeType: true, fileName: true, sizeBytes: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

export async function photosOf(ids: string[], byId: Map<string, AttRow>): Promise<PhotoDto[]> {
  const out: PhotoDto[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    const isImage = r.mimeType.startsWith('image/');
    out.push({ id: r.id, mimeType: r.mimeType, url: (await signedUrlFor(r)).url, thumbUrl: isImage ? (await signedUrlFor(r, { thumbnailWidth: 320 })).url : (await signedUrlFor(r)).url });
  }
  return out;
}

export async function fileOf(r: AttRow | undefined): Promise<FileDto | null> {
  if (!r) return null;
  const signed = await signedUrlFor(r);
  return {
    id: r.id,
    fileName: r.fileName,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    url: signed.url,
    thumbUrl: r.mimeType.startsWith('image/') ? (await signedUrlFor(r, { thumbnailWidth: 480 })).url : null,
    expiresAt: signed.expiresAt.toISOString(),
  };
}

export interface Person {
  id: string;
  name: string;
}

/** Names of users by id (one query). */
export async function peopleById(tx: Tx, tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map();
  const rows = await tx.user.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

export const personOf = (people: Map<string, Person>, id: string | null | undefined): Person | null => (id ? (people.get(id) ?? null) : null);

/** Serialises a write per project (snag numbers, revision numbers, handover). */
export async function lockKey(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
