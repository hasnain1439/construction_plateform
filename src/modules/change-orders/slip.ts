/**
 * Step 15 · Change order slip (owner-facing PDF) + its WhatsApp text. Letterhead, project, CO code,
 * title and details, the items at the owner's PRICE (never cost or markup), total (minus for a
 * deduction), days impact, approval proof and owner / contractor signature lines. Urdu =
 * right-to-left with the embedded Nastaliq font (core/pdf/templates.ts).
 */
import { withPdfTenant } from '../../core/db/withTenant.js';
import { Forbidden } from '../../core/errors/AppError.js';
import type { Lang, MessageKey, Params } from '../../core/i18n/index.js';
import { tr, trCount, unitLabel } from '../../core/i18n/index.js';
import { auto, date, day, esc, label, ltr, qtyUnit, rs, shell, type Letterhead } from '../../core/pdf/templates.js';
import type { ChangeOrderProofType, ChangeOrderStatus, ChangeOrderType } from '../../generated/prisma/client.js';
import { documentLang, letterhead, pdfFileName, salutation, shareOf, storePdf } from '../billing/documents.js';
import type { PdfQuery } from './changeOrders.schema.js';
import { audit, coActor, findCo, seesPrice, ymd } from './changeOrders.shared.js';
import { changeOrderCode } from './totals.js';

export interface SlipData {
  company: Letterhead;
  project: { name: string; code: string; address: string | null };
  client: { name: string; phone: string | null } | null;
  code: string;
  title: string;
  description: string | null;
  type: ChangeOrderType;
  status: ChangeOrderStatus;
  createdOn: string;
  lines: Array<{ description: string; quantity: string; unit: string; priceRatePaisa: bigint; priceAmountPaisa: bigint }>;
  totalPaisa: bigint;
  daysImpact: number;
  approvedOn: string | null;
  proofType: ChangeOrderProofType | null;
}

const money = (p: bigint) => ltr(rs(p));

export function slipHtml(d: SlipData, lang: Lang = 'en'): string {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  const qty = (q: string) => q.replace(/\.?0+$/, '');
  const rows = d.lines
    .map(
      (l, i) =>
        `<tr><td>${i + 1}</td><td>${auto(esc(l.description))}</td><td class="r">${qtyUnit(esc(qty(l.quantity)), unitLabel(lang, l.unit))}</td><td class="r">${money(l.priceRatePaisa)}</td><td class="r">${money(l.priceAmountPaisa)}</td></tr>`,
    )
    .join('');
  const deduction = d.type === 'DEDUCTION';
  const body = `
  <div class="grid">
    <div><div class="label">${L('pdf.owner')}</div><strong>${esc(d.client?.name ?? '—')}</strong>${d.client?.phone ? `<div class="muted">${ltr(esc(d.client.phone))}</div>` : ''}</div>
    <div><div class="label">${L('pdf.project')}</div><strong>${esc(d.project.name)}</strong><div class="muted">${ltr(esc(d.project.code))}${d.project.address ? `<br>${esc(d.project.address)}` : ''}</div></div>
    <div><div class="label">${L('pdf.changeOrderKind')}</div><strong>${L(`pdf.changeOrderType.${d.type}` as MessageKey)}</strong></div>
  </div>
  <h3>${ltr(esc(d.code))} · ${auto(esc(d.title))}</h3>
  ${d.description ? `<div class="note" dir="auto">${esc(d.description)}</div>` : ''}
  <div class="note">${L(deduction ? 'pdf.changeOrderIntroDeduction' : 'pdf.changeOrderIntro')}</div>
  ${
    d.lines.length
      ? `<table><thead><tr><th>#</th><th>${L('pdf.description')}</th><th class="r">${L('pdf.qty')}</th><th class="r">${L('pdf.rate')}</th><th class="r">${L('pdf.amount')}</th></tr></thead><tbody>${rows}</tbody></table>`
      : ''
  }
  <table class="totals">
    <tr class="grand"><td>${L(deduction ? 'pdf.changeOrderDeduction' : 'pdf.changeOrderTotal')}</td><td class="r">${money(d.totalPaisa)}</td></tr>
    <tr><td>${L('pdf.daysImpact')}</td><td class="r">${d.daysImpact > 0 ? L(d.daysImpact === 1 ? 'pdf.daysImpactValue.one' : 'pdf.daysImpactValue.other', { count: d.daysImpact }) : L('pdf.noDaysImpact')}</td></tr>
  </table>
  ${d.approvedOn ? `<div class="note">${L('pdf.changeOrderApproved', {}, { date: date(d.approvedOn) })}${d.proofType ? ` · ${L(`pdf.proofType.${d.proofType}` as MessageKey)}` : ''}</div>` : ''}
  <div class="grid" style="margin-top:36px">
    <div>
      <div class="label">${L('pdf.ownerApproval')}</div>
      <div style="height:60px"></div>
      <div style="border-top:1px solid #0f172a;padding-top:4px"><strong>${esc(d.client?.name ?? '')}</strong> · ${L('pdf.signature')} · ${L('pdf.date')}</div>
    </div>
    <div>
      <div class="label">${L('pdf.forContractor')}</div>
      <div style="height:60px"></div>
      <div style="border-top:1px solid #0f172a;padding-top:4px"><strong>${esc(d.company.name)}</strong> · ${L('pdf.signature')}</div>
    </div>
  </div>`;
  return shell(d.company, tr(lang, 'pdf.changeOrder'), `${ltr(esc(d.code))}<br>${date(d.createdOn)}`, body, lang);
}

/** Statuses whose WhatsApp text asks the owner to approve (QA-B-16); later ones just inform. */
export const ASKS_APPROVAL: ReadonlySet<ChangeOrderStatus> = new Set<ChangeOrderStatus>(['DRAFT', 'SENT']);

/**
 * The WhatsApp text of a change order (QA-B-16): DRAFT / SENT ask "Please reply OK to approve";
 * APPROVED / IN_PROGRESS / COMPLETED / BILLED / REJECTED state the status instead. Days are plural-aware.
 * An approved change order also says when it was approved ("approved on …", QA-A-27) when `approvedOn` is given.
 */
export function changeOrderWhatsapp(
  lang: Lang,
  status: ChangeOrderStatus,
  p: { salutation: string; project: string; code: string; title: string; amount: string; days: number; url: string; approvedOn?: string | null },
): string {
  const params = { salutation: p.salutation, project: p.project, code: p.code, title: p.title, amount: p.amount, url: p.url };
  if (ASKS_APPROVAL.has(status)) return p.days > 0 ? trCount(lang, 'share.changeOrderDays', p.days, params) : tr(lang, 'share.changeOrder', params);
  const withStatus = { ...params, status: tr(lang, `report.v.coStatus.${status}` as MessageKey) };
  if (p.approvedOn && status !== 'REJECTED') {
    const approved = { ...withStatus, date: day(p.approvedOn) };
    return p.days > 0 ? trCount(lang, 'share.changeOrderApprovedDays', p.days, approved) : tr(lang, 'share.changeOrderApproved', approved);
  }
  return p.days > 0 ? trCount(lang, 'share.changeOrderInfoDays', p.days, withStatus) : tr(lang, 'share.changeOrderInfo', withStatus);
}

/** The slip PDF (DOCUMENT attachment) + durable share link + WhatsApp text. Needs the owner price visible. */
export async function slipPdf(id: string, query: PdfQuery) {
  const a = coActor();
  return withPdfTenant(a.tenantId, async (tx) => {
    const { co, project } = await findCo(tx, a, id, 'changeorder.view');
    if (!seesPrice(a)) {
      throw new Forbidden('PERMISSION_DENIED', 'The slip shows prices: it needs the "See rates" or "See amounts" permission', { permission: 'fields.amounts', anyOf: ['fields.rates', 'fields.amounts'] });
    }
    const client = project.clientId ? await tx.client.findFirst({ where: { tenantId: a.tenantId, id: project.clientId }, select: { name: true, phone: true } }) : null;
    const lang = await documentLang(tx, a.userId, query.lang);
    const code = changeOrderCode(co.number);
    const html = slipHtml(
      {
        company: await letterhead(tx, a.tenantId),
        project: { name: project.name, code: project.code, address: [project.siteAddress, project.city].filter(Boolean).join(', ') || null },
        client,
        code,
        title: co.title,
        description: co.description,
        type: co.type,
        status: co.status,
        createdOn: ymd(co.createdAt)!,
        lines: co.lines.map((l) => ({ description: l.description, quantity: l.quantity.toFixed(3), unit: l.unit, priceRatePaisa: l.priceRatePaisa, priceAmountPaisa: l.priceAmountPaisa })),
        totalPaisa: co.totalPaisa,
        daysImpact: co.daysImpact,
        approvedOn: ymd(co.approvedOn),
        proofType: co.approvedOn ? co.proofType : null,
      },
      lang,
    );
    const attachmentId = await storePdf(tx, a.tenantId, a.userId, 'DOCUMENT', pdfFileName(`${code} ${project.code}`, lang), html, `${tr(lang, 'pdf.changeOrder')} · ${code} · ${project.name}`, lang);
    await audit(tx, a, 'changeorder.pdf', 'ChangeOrder', co.id, { code, attachmentId, lang });
    const share = await shareOf(tx, a.tenantId, attachmentId, (url) =>
      // An approved change order is not sent for approval again (QA-A-27 / QA-B-16)
      changeOrderWhatsapp(lang, co.status, {
        salutation: salutation(client?.name, lang),
        project: project.name,
        code,
        title: co.title,
        amount: rs(co.totalPaisa),
        days: co.daysImpact,
        approvedOn: ymd(co.approvedOn),
        url,
      }),
    );
    return { ...share!, clientPhone: client?.phone ?? null };
  });
}
