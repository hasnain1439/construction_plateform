/** Stores generated PDFs as attachments and builds the share payload ({ url, expiresAt, whatsappText }). */
import type { Tx } from '../../core/db/withTenant.js';
import { renderPdf } from '../../core/pdf/renderer.js';
import { dayMonth, type Letterhead } from '../../core/pdf/templates.js';
import { uuidv7 } from '../../core/utils/uuid.js';
import type { AttachmentKind } from '../../generated/prisma/client.js';
import { signedUrlFor } from '../attachments/attachments.service.js';
import { storage } from '../attachments/storage.provider.js';
import { companyOf } from './billing.shared.js';

export async function letterhead(tx: Tx, tenantId: string): Promise<Letterhead> {
  const c = await companyOf(tx, tenantId);
  return {
    name: c.name,
    ntn: c.ntn,
    address: c.address,
    phone: c.phone,
    logoUrl: c.logo ? await signedUrlFor(c.logo).then((s) => s.url).catch(() => null) : null,
  };
}

/** Renders `html`, stores it and returns the attachment id. */
export async function storePdf(tx: Tx, tenantId: string, userId: string | null, kind: AttachmentKind, fileName: string, html: string, footer: string): Promise<string> {
  const buffer = await renderPdf(html, footer);
  const id = uuidv7();
  const now = new Date();
  const key = await storage().put(`${tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.pdf`, buffer, 'application/pdf');
  await tx.attachment.create({ data: { id, tenantId, kind, storageKey: key, fileName, mimeType: 'application/pdf', sizeBytes: buffer.length, uploadedById: userId } });
  return id;
}

export async function shareOf(tx: Tx, tenantId: string, attachmentId: string, whatsappText: (url: string) => string) {
  const att = await tx.attachment.findFirst({ where: { tenantId, id: attachmentId } });
  if (!att) return null;
  const signed = await signedUrlFor(att);
  return { attachmentId, url: signed.url, expiresAt: signed.expiresAt.toISOString(), whatsappText: whatsappText(signed.url) };
}

/**
 * Runs PDF making in the background and waits for it at most `ms` (a slow or missing
 * browser never holds up issuing / recording; the PDF is then made on first download).
 */
export async function withinOrBackground(job: () => Promise<unknown>, onError: (err: unknown) => void, ms = 4_000): Promise<void> {
  const running = job().catch(onError);
  await Promise.race([running, new Promise((resolve) => setTimeout(resolve, ms))]);
}

/** "12 Oct" */
export const shortDay = (date: string | null) => (date ? dayMonth(date) : '');

/** "Ahmed Raza sahib" */
export const salutation = (name: string | null | undefined) => (name ? `Assalam o Alaikum ${name} sahib` : 'Assalam o Alaikum');
