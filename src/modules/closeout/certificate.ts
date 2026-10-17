/**
 * Handover certificate (owner-facing PDF): letterhead, project, handover date, checklist, defect
 * liability period, owner sign-off and signature lines. No money on it. Urdu = right-to-left with
 * the embedded Nastaliq font (core/pdf/templates.ts).
 */
import type { Lang, MessageKey, Params } from '../../core/i18n/index.js';
import { tr } from '../../core/i18n/index.js';
import { date, esc, label, ltr, shell, type Letterhead } from '../../core/pdf/templates.js';
import type { HandoverItemKey } from '../../generated/prisma/client.js';

export interface CertificateData {
  company: Letterhead;
  project: { name: string; code: string; address: string | null };
  client: { name: string } | null;
  handoverDate: string | null;
  signedOn: string | null;
  ownerName: string | null;
  signatureUrl: string | null;
  items: Array<{ key: HandoverItemKey; done: boolean; note: string | null }>;
  defectPeriodMonths: number;
  defectPeriodUntil: string | null;
}

export function certificateHtml(d: CertificateData, lang: Lang = 'en'): string {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  const handover = d.handoverDate ?? d.signedOn;
  const rows = d.items
    .map(
      (i) =>
        `<tr><td>${L(`pdf.handoverItem.${i.key}` as MessageKey)}</td><td><span class="badge ${i.done ? 'ok' : 'warn'}">${L(i.done ? 'pdf.itemDone' : 'pdf.itemPending')}</span></td><td>${esc(i.note ?? '')}</td></tr>`,
    )
    .join('');
  const body = `
  <div class="grid">
    <div><div class="label">${L('pdf.owner')}</div><strong>${esc(d.client?.name ?? d.ownerName ?? '—')}</strong></div>
    <div><div class="label">${L('pdf.project')}</div><strong>${esc(d.project.name)}</strong><div class="muted">${ltr(esc(d.project.code))}</div></div>
    <div><div class="label">${L('pdf.handoverDate')}</div><strong>${date(handover)}</strong></div>
  </div>
  ${d.project.address ? `<div class="grid"><div><div class="label">${L('pdf.siteAddress')}</div>${esc(d.project.address)}</div></div>` : ''}
  <div class="note">${L('pdf.handoverIntro', { project: d.project.name }, { date: date(handover) })}</div>
  <h3>${L('pdf.handoverChecklist')}</h3>
  <table><thead><tr><th>${L('pdf.description')}</th><th>${L('pdf.itemDone')}</th><th>${L('pdf.detail')}</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="grid" style="margin-top:16px">
    <div><div class="label">${L('pdf.defectPeriod')}</div><strong>${L('pdf.defectPeriodUntil', { months: d.defectPeriodMonths }, { date: date(d.defectPeriodUntil) })}</strong><div class="muted">${L('pdf.defectPeriodNote')}</div></div>
  </div>
  <h3>${L('pdf.ownerSignOff')}</h3>
  <div class="grid" style="margin-top:24px">
    <div>
      <div class="label">${L('pdf.receivedByOwner')}</div>
      ${d.signatureUrl ? `<img src="${esc(d.signatureUrl)}" alt="" style="max-height:70px;max-width:220px">` : '<div style="height:60px"></div>'}
      <div style="border-top:1px solid #0f172a;padding-top:4px"><strong>${esc(d.ownerName ?? '')}</strong> · ${date(d.signedOn)}</div>
    </div>
    <div>
      <div class="label">${L('pdf.forContractor')}</div>
      <div style="height:60px"></div>
      <div style="border-top:1px solid #0f172a;padding-top:4px"><strong>${esc(d.company.name)}</strong> · ${L('pdf.signature')}</div>
    </div>
  </div>`;
  return shell(d.company, tr(lang, 'pdf.handoverCertificate'), date(handover), body, lang);
}
