/** Stores generated PDFs as attachments and builds the share payload ({ url, expiresAt, whatsappText }). */
import type { Tx } from '../../core/db/withTenant.js';
import { renderPdf } from '../../core/pdf/renderer.js';
import { dayMonth, type Letterhead } from '../../core/pdf/templates.js';
import { tr, type Lang } from '../../core/i18n/index.js';
import { responseLang } from '../../core/i18n/requestLang.js';
import { uuidv7 } from '../../core/utils/uuid.js';
import type { AttachmentKind } from '../../generated/prisma/client.js';
import { namedSignedUrl, shareLinkFor, signedUrlFor } from '../attachments/attachments.service.js';
import { storage } from '../attachments/storage.provider.js';
import { companyOf } from './billing.shared.js';

/**
 * The company letterhead every PDF prints (templates.ts shell): name, logo, address, phone, NTN.
 * `taxIds`: also the sales tax registration (STRN) — tax reports. (A taxed invoice prints the
 * NTN / STRN snapshot taken when it was issued, under its totals.)
 */
export async function letterhead(tx: Tx, tenantId: string, opts: { taxIds?: boolean } = {}): Promise<Letterhead> {
  const c = await companyOf(tx, tenantId);
  return {
    name: c.name,
    ntn: c.ntn,
    address: c.address,
    phone: c.phone,
    logoUrl: c.logo ? await signedUrlFor(c.logo).then((s) => s.url).catch(() => null) : null,
    strn: opts.taxIds ? ((await tx.tenantSettings.findUnique({ where: { tenantId }, select: { taxStrn: true } }))?.taxStrn ?? null) : null,
  };
}

/**
 * The language of a company document: `?lang=` when given, else the web's UI language (X-Lang,
 * QA-B-20), else the requesting user's account language. (Owner-facing PDFs follow the office
 * user who makes them.)
 */
export async function documentLang(tx: Tx, userId: string | null, override?: Lang): Promise<Lang> {
  if (override) return override;
  return responseLang(tx, userId);
}

/** "INV-2026-001.pdf" (English) / "INV-2026-001-ur.pdf" — the language is part of the stored file name (cache key). */
export const pdfFileName = (base: string, lang: Lang) => `${base}${lang === 'en' ? '' : `-${lang}`}.pdf`;

/** Renders `html`, stores it and returns the attachment id. */
export async function storePdf(tx: Tx, tenantId: string, userId: string | null, kind: AttachmentKind, fileName: string, html: string, footer: string, lang: Lang = 'en'): Promise<string> {
  const buffer = await renderPdf(html, footer, lang);
  const id = uuidv7();
  const now = new Date();
  const key = await storage().put(`${tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.pdf`, buffer, 'application/pdf');
  await tx.attachment.create({ data: { id, tenantId, kind, storageKey: key, fileName, mimeType: 'application/pdf', sizeBytes: buffer.length, uploadedById: userId } });
  return id;
}

/**
 * Share payload; null when the attachment is gone (or is not `fileName`, i.e. another language).
 *
 * QA-B-02: `url` is the DURABLE share link (GET /public/files/:id, valid SHARE_LINK_TTL_DAYS,
 * default 30 days; `expiresAt` is its expiry) — the one put in `whatsappText`. `fileUrl` /
 * `fileUrlExpiresAt` is the short-lived signed storage link (named after the file) for previews.
 */
export async function shareOf(tx: Tx, tenantId: string, attachmentId: string, whatsappText: (url: string) => string, fileName?: string) {
  const att = await tx.attachment.findFirst({ where: { tenantId, id: attachmentId } });
  if (!att || (fileName !== undefined && att.fileName !== fileName)) return null;
  const share = shareLinkFor(att);
  const file = await namedSignedUrl(att);
  return { attachmentId, url: share.url, expiresAt: share.expiresAt.toISOString(), fileUrl: file.url, fileUrlExpiresAt: file.expiresAt.toISOString(), whatsappText: whatsappText(share.url) };
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

/** "Assalam o Alaikum Ahmed Raza sahib" in the document language (default Roman Urdu). */
export const salutation = (name: string | null | undefined, lang: Lang = 'roman') => (name ? tr(lang, 'share.salutation', { name }) : tr(lang, 'share.salutationNoName'));
