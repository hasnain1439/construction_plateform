/**
 * Step 12 · Quotes (sales pipeline).
 *
 *   create       POST /quotes                → DRAFT, Q-YYYY-NNNN, revision 1 (quick-mode estimate)
 *   revision     POST /quotes/:id/revisions  → revision + 1 (EXPIRED → DRAFT with a fresh validity)
 *   send         POST /quotes/:id/send       → SENT + customer PDF + WhatsApp text
 *   negotiation  POST /quotes/:id/negotiation→ NEGOTIATION (note)
 *   lost         POST /quotes/:id/lost       → LOST (reason; OTHER needs a note)
 *   won          POST /quotes/:id/won        → WON + a pre-filled DRAFT project (idempotent)
 *   expiry job   jobs/quoteExpiry.ts         → SENT / NEGOTIATION past validUntil → EXPIRED
 *
 * Every write is audited (entityType "Quote") in the same transaction; the audit rows are the
 * quote's activity list. Money visibility: sales.dto.ts.
 */
import { writeAudit } from '../../core/audit/audit.js';
import { assertPerm, fieldAccess, type FieldAccess } from '../../core/auth/access.js';
import { nextNumber } from '../../core/db/counters.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { tr, type Lang } from '../../core/i18n/index.js';
import { day, quoteCustomerHtml, quoteInternalHtml, rs, type QuotePdfData } from '../../core/pdf/templates.js';
import { dateOnly } from '../../core/utils/dates.js';
import { Prisma, type Quote, type QuoteRevision } from '../../generated/prisma/client.js';
import { addDays, today } from '../billing/billing.shared.js';
import { documentLang, letterhead, pdfFileName, salutation, shareOf, storePdf } from '../billing/documents.js';
import { createClientTx } from '../clients/clients.service.js';
import { caller, type Caller } from '../projects/access.js';
import { nextProjectCode } from '../projects/code.js';
import { FLOOR_LEVELS, FLOOR_NAMES } from '../projects/presets.js';
import { audit as projectAudit } from '../projects/projects.service.js';
import { recomputeStageAmounts } from '../projects/wizard.service.js';
import { companyQuoteSettings, computeQuote, supplySplit, type PaymentStage, type QuoteComputation, type QuoteInputs, type QuoteResult } from './quote.compute.js';
import { QUICK_PARAMS, QUICK_VALUES, quickCeiling } from './quickMode.js';
import {
  activityDetails,
  computedDto,
  FOLLOW_UP_DAYS,
  revisionDto,
  revisionListItem,
  summaryDto,
  type QuoteRow,
  type RevisionRow,
  type WonProject,
} from './sales.dto.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import type { AddRevisionInput, QuoteInputsInput, CreateQuoteInput, ListQuotesQuery, LostInput, PdfQuery, SendQuoteInput, UpdateQuoteInput, WonInput } from './sales.schema.js';

export const QUOTE_NUMBER_FORMAT = 'Q-{YYYY}-####';
const DAY_MS = 86_400_000;

const userSel = { select: { id: true, name: true } } as const;
const quoteInclude = { client: { select: { id: true, name: true, phone: true } }, createdBy: userSel } as const;
const revisionInclude = { createdBy: userSel } as const;

export const quoteNotFound = () => new NotFound('QUOTE_NOT_FOUND', 'Quote not found');
const closed = (q: Pick<Quote, 'status'>) => new Conflict('QUOTE_CLOSED', `This quote is ${q.status.toLowerCase()} — it can no longer change`, { status: q.status });
const fieldsOf = (c: Caller): FieldAccess => c.fields ?? fieldAccess();

function audit(tx: Tx, c: Pick<Caller, 'tenantId' | 'userId'>, action: string, quoteId: string, details: Prisma.InputJsonValue) {
  return writeAudit(tx, { tenantId: c.tenantId, actorType: 'USER', actorId: c.userId, action, entityType: 'Quote', entityId: quoteId, details });
}

async function findQuote(tx: Tx, id: string): Promise<QuoteRow> {
  const q = await tx.quote.findUnique({ where: { id }, include: quoteInclude });
  if (!q) throw quoteNotFound();
  return q;
}

async function wonProjectOf(tx: Tx, q: Pick<Quote, 'wonProjectId'>): Promise<WonProject> {
  if (!q.wonProjectId) return null;
  return tx.project.findUnique({ where: { id: q.wonProjectId }, select: { id: true, code: true, name: true, status: true } });
}

async function detail(tx: Tx, c: Caller, id: string) {
  const q = await findQuote(tx, id);
  const fa = fieldsOf(c);
  const revisions = (await tx.quoteRevision.findMany({ where: { quoteId: id }, include: revisionInclude, orderBy: { revision: 'desc' } })) as RevisionRow[];
  const logs = await tx.auditLog.findMany({ where: { entityType: 'Quote', entityId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
  const actorIds = [...new Set(logs.map((l) => l.actorId).filter((x): x is string => Boolean(x)))];
  const people = new Map((await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((u) => [u.id, u]));
  return {
    ...summaryDto(q, fa, await wonProjectOf(tx, q)),
    notes: q.notes,
    latest: revisionDto(revisions[0]!, fa),
    revisions: revisions.map((r) => revisionListItem(r, fa)),
    activity: logs.map((l) => ({
      action: l.action,
      at: l.createdAt.toISOString(),
      by: l.actorType === 'USER' && l.actorId ? (people.get(l.actorId) ?? null) : null,
      system: l.actorType === 'SYSTEM',
      details: activityDetails(l.details, fa),
    })),
  };
}

export type QuoteDetailDto = Awaited<ReturnType<typeof detail>>;

/** Columns of a revision row from a computation. */
export function revisionData(comp: QuoteComputation, tenantId: string, quoteId: string, revision: number, note: string | null | undefined, userId: string) {
  return {
    tenantId,
    quoteId,
    revision,
    inputs: comp.inputs as unknown as Prisma.InputJsonValue,
    result: comp.result as unknown as Prisma.InputJsonValue,
    paymentStages: comp.paymentStages as unknown as Prisma.InputJsonValue,
    paymentTemplateId: comp.paymentTemplate?.id ?? null,
    paymentTemplateName: comp.paymentTemplate?.name ?? null,
    contractType: comp.inputs.contractType,
    coveredAreaSqft: comp.inputs.coveredAreaSqft,
    directCostPaisa: comp.directCostPaisa,
    overheadPaisa: comp.overheadPaisa,
    contingencyPaisa: comp.contingencyPaisa,
    costPaisa: comp.costPaisa,
    finishingAllowancePaisa: comp.finishingAllowancePaisa,
    computedPricePaisa: comp.computedPricePaisa,
    pricePaisa: comp.pricePaisa!,
    perSqftPaisa: comp.perSqftPaisa,
    marginPercent: comp.inputs.marginPercent,
    finishingAllowancePercent: comp.inputs.finishingAllowancePercent,
    marginPaisa: comp.marginPaisa ?? 0n,
    note: note ?? null,
    createdById: userId,
  };
}

async function priced(tx: Tx, tenantId: string, inputs: QuoteInputsInput): Promise<QuoteComputation> {
  const comp = await computeQuote(tx, tenantId, inputs);
  if (comp.pricePaisa === null) {
    throw new BadRequest('QUOTE_PRICE_MISSING', 'No cost could be worked out (material / labour rates missing) — enter the final price (finalPricePaisa)');
  }
  return comp;
}

const latestFields = (comp: QuoteComputation, revision: number) => ({
  revision,
  contractType: comp.inputs.contractType,
  coveredAreaSqft: comp.inputs.coveredAreaSqft,
  pricePaisa: comp.pricePaisa!,
  perSqftPaisa: comp.perSqftPaisa,
});

// ─── Reads ──────────────────────────────────────────────────────────────────

export const assumptions = () => QUICK_PARAMS.map((p) => ({ ...p }));

export async function preview(inputs: QuoteInputsInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const comp = await computeQuote(tx, c.tenantId, inputs);
    return computedDto(
      { ...comp, marginPercent: comp.inputs.marginPercent, finishingAllowancePercent: comp.inputs.finishingAllowancePercent },
      fieldsOf(c),
    );
  });
}

export async function listQuotes(query: ListQuotesQuery) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const and: Prisma.QuoteWhereInput[] = [];
    if (query.status) and.push({ status: query.status });
    if (query.clientId) and.push({ clientId: query.clientId });
    if (query.followUp) and.push({ status: 'SENT', lastActivityAt: { lt: new Date(Date.now() - FOLLOW_UP_DAYS * DAY_MS) } });
    if (query.search) {
      const s = query.search;
      and.push({
        OR: [
          { number: { contains: s, mode: 'insensitive' } },
          { title: { contains: s, mode: 'insensitive' } },
          { client: { name: { contains: s, mode: 'insensitive' } } },
          { client: { phone: { contains: s.replace(/[\s-]/g, '') } } },
        ],
      });
    }
    const where: Prisma.QuoteWhereInput = { AND: and };
    const rows = await tx.quote.findMany({ where, include: quoteInclude, orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }], ...skipTake(query) });
    const projectIds = rows.map((r) => r.wonProjectId).filter((x): x is string => Boolean(x));
    const projects = new Map((await tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, code: true, name: true, status: true } })).map((p) => [p.id, p]));
    const fa = fieldsOf(c);
    const now = new Date();
    return {
      data: rows.map((q) => summaryDto(q, fa, q.wonProjectId ? (projects.get(q.wonProjectId) ?? null) : null, now)),
      meta: pageMeta(query, await tx.quote.count({ where })),
    };
  });
}

export async function getQuote(id: string) {
  const c = caller();
  return withTenant(c.tenantId, (tx) => detail(tx, c, id));
}

export async function listRevisions(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    await findQuote(tx, id);
    const rows = (await tx.quoteRevision.findMany({ where: { quoteId: id }, include: revisionInclude, orderBy: { revision: 'desc' } })) as RevisionRow[];
    return rows.map((r) => revisionDto(r, fieldsOf(c)));
  });
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function createQuote(input: CreateQuoteInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    let clientId = input.clientId;
    if (input.newClient) {
      assertPerm('clients.client.create');
      clientId = (await createClientTx(tx, input.newClient)).id;
    } else if (!(await tx.client.findUnique({ where: { id: clientId! }, select: { id: true } }))) {
      throw new BadRequest('INVALID_CLIENT', 'Client not found in this company');
    }
    const comp = await priced(tx, c.tenantId, input.inputs);
    const company = await companyQuoteSettings(tx, c.tenantId);
    const number = await nextNumber(tx, c.tenantId, QUOTE_NUMBER_FORMAT);
    const q = await tx.quote.create({
      data: {
        tenantId: c.tenantId,
        number,
        clientId: clientId!,
        title: input.title,
        siteAddress: input.siteAddress ?? null,
        city: input.city ?? null,
        status: 'DRAFT',
        validUntil: dateOnly(input.validUntil ?? addDays(today(), company.quoteValidityDays)),
        notes: input.notes ?? null,
        ...latestFields(comp, 1),
        createdById: c.userId,
      },
    });
    await tx.quoteRevision.create({ data: revisionData(comp, c.tenantId, q.id, 1, input.note, c.userId) });
    await audit(tx, c, 'quote.create', q.id, { number, title: q.title, revision: 1, pricePaisa: comp.pricePaisa!.toString(), contractType: comp.inputs.contractType });
    return detail(tx, c, q.id);
  });
}

export async function updateQuote(id: string, input: UpdateQuoteInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const q = await findQuote(tx, id);
    if (q.status === 'WON' || q.status === 'LOST') throw closed(q);
    if (input.clientId && !(await tx.client.findUnique({ where: { id: input.clientId }, select: { id: true } }))) {
      throw new BadRequest('INVALID_CLIENT', 'Client not found in this company');
    }
    await tx.quote.update({
      where: { id },
      data: {
        ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.siteAddress !== undefined ? { siteAddress: input.siteAddress } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.validUntil !== undefined ? { validUntil: dateOnly(input.validUntil) } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        lastActivityAt: new Date(),
      },
    });
    await audit(tx, c, 'quote.update', id, { number: q.number, changed: Object.keys(input).filter((k) => input[k as keyof UpdateQuoteInput] !== undefined).sort() });
    return detail(tx, c, id);
  });
}

export async function deleteQuote(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const q = await findQuote(tx, id);
    if (q.status === 'WON') throw new Conflict('QUOTE_WON', 'A won quote cannot be deleted — its project was made from it', { projectId: q.wonProjectId });
    await tx.quote.delete({ where: { id } }); // revisions cascade
    await audit(tx, c, 'quote.delete', id, { number: q.number, title: q.title, status: q.status });
    return { id, deleted: true };
  });
}

export async function addRevision(id: string, input: AddRevisionInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const q = await findQuote(tx, id);
    if (q.status === 'WON' || q.status === 'LOST') throw closed(q);
    const comp = await priced(tx, c.tenantId, input.inputs);
    const revision = q.revision + 1;
    await tx.quoteRevision.create({ data: revisionData(comp, c.tenantId, id, revision, input.note, c.userId) });
    const reopen = q.status === 'EXPIRED';
    const validity = reopen ? (await companyQuoteSettings(tx, c.tenantId)).quoteValidityDays : 0;
    await tx.quote.update({
      where: { id },
      data: {
        ...latestFields(comp, revision),
        lastActivityAt: new Date(),
        ...(reopen ? { status: 'DRAFT', expiredAt: null, validUntil: dateOnly(addDays(today(), validity)) } : {}),
      },
    });
    await audit(tx, c, 'quote.revision', id, {
      number: q.number,
      revision,
      pricePaisa: comp.pricePaisa!.toString(),
      previousPricePaisa: q.pricePaisa.toString(),
      ...(reopen ? { reopened: true } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    return detail(tx, c, id);
  });
}

// ─── PDFs ───────────────────────────────────────────────────────────────────

async function pdfData(tx: Tx, c: Caller, q: QuoteRow, r: QuoteRevision): Promise<QuotePdfData> {
  const inputs = r.inputs as unknown as QuoteInputs;
  const result = r.result as unknown as QuoteResult;
  const stages = r.paymentStages as unknown as PaymentStage[];
  return {
    company: await letterhead(tx, c.tenantId),
    client: { name: q.client.name, phone: q.client.phone },
    number: q.number,
    revision: r.revision,
    date: today(),
    validUntil: q.validUntil.toISOString().slice(0, 10),
    title: q.title,
    siteAddress: q.siteAddress,
    city: q.city,
    contractType: inputs.contractType,
    structureType: inputs.structureType,
    plot: { unit: inputs.plot.unit, size: inputs.plot.size, frontFt: inputs.plot.frontFt, depthFt: inputs.plot.depthFt },
    coveredAreaSqft: inputs.coveredAreaSqft,
    floors: inputs.floors,
    basement: inputs.basement,
    mumty: inputs.mumty,
    sections: result.sections.map((s) => s.section).filter((s) => s !== 'SITE_OVERHEADS' && s !== 'CONTINGENCY'),
    specifications: result.specifications.map((s) => ({ categoryKey: s.categoryKey, suppliedBy: s.suppliedBy, quality: s.qualityCategory?.name ?? null, materials: s.materials })),
    paymentStages: stages.map((s) => ({ label: s.label, percent: s.percent, amountPaisa: BigInt(s.amountPaisa ?? '0') })),
    pricePaisa: r.pricePaisa,
    perSqftPaisa: r.perSqftPaisa,
  };
}

/** Customer quotation HTML of the latest revision (exported for tests: it must never carry internal numbers). */
export async function customerHtml(tx: Tx, c: Caller, q: QuoteRow, lang: Lang) {
  const r = await tx.quoteRevision.findFirstOrThrow({ where: { quoteId: q.id, revision: q.revision } });
  return { html: quoteCustomerHtml(await pdfData(tx, c, q, r), lang), revision: r };
}

async function customerShare(tx: Tx, c: Caller, q: QuoteRow, lang: Lang) {
  const { html, revision } = await customerHtml(tx, c, q, lang);
  const name = pdfFileName(`Quotation ${q.number} Rev ${revision.revision}`, lang);
  const id = await storePdf(tx, c.tenantId, c.userId, 'REPORT', name, html, `${tr(lang, 'pdf.quote')} · ${q.number}`, lang);
  const share = await shareOf(tx, c.tenantId, id, (url) =>
    tr(lang, 'share.quote', {
      salutation: salutation(q.client.name, lang),
      number: q.number,
      title: q.title,
      amount: rs(revision.pricePaisa),
      rate: revision.perSqftPaisa === null ? '—' : rs(revision.perSqftPaisa),
      date: day(q.validUntil.toISOString().slice(0, 10)),
      url,
    }),
  );
  return { ...share!, clientPhone: q.client.phone };
}

export async function quotePdf(id: string, query: PdfQuery) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const q = await findQuote(tx, id);
    const fa = fieldsOf(c);
    const lang = await documentLang(tx, c.userId, query.lang);
    if (query.variant === 'customer') {
      assertPerm('fields.contract', undefined, 'The quotation shows the price — it needs the contract-value permission');
      return customerShare(tx, c, q, lang);
    }
    assertPerm('fields.rates', undefined, 'The internal costing shows costs — it needs the rates permission');
    const r = await tx.quoteRevision.findFirstOrThrow({ where: { quoteId: q.id, revision: q.revision } });
    const base = await pdfData(tx, c, q, r);
    const result = r.result as unknown as QuoteResult;
    const html = quoteInternalHtml(
      {
        ...base,
        status: q.status,
        costSections: result.sections.map((s) => ({ section: s.section, amountPaisa: BigInt(s.amountPaisa) })),
        directCostPaisa: r.directCostPaisa,
        overheadPaisa: r.overheadPaisa,
        contingencyPaisa: r.contingencyPaisa,
        costPaisa: r.costPaisa,
        finishingAllowancePaisa: r.finishingAllowancePaisa,
        costPerSqftPaisa: Number(r.coveredAreaSqft) > 0 ? BigInt(Math.round(Number(r.costPaisa) / Number(r.coveredAreaSqft))) : null,
        margin:
          fa.contract && fa.profit
            ? { marginPercent: Number(r.marginPercent), marginPaisa: r.marginPaisa, marginOnPricePercent: r.pricePaisa > 0n ? Math.round((Number(r.marginPaisa) / Number(r.pricePaisa)) * 10_000) / 100 : null }
            : null,
        showPrice: fa.contract,
      },
      lang,
    );
    const name = pdfFileName(`Quote costing ${q.number} Rev ${r.revision}${fa.contract && fa.profit ? '' : fa.contract ? ' price' : ' cost'}`, lang);
    const attachmentId = await storePdf(tx, c.tenantId, c.userId, 'REPORT', name, html, `${tr(lang, 'pdf.quoteInternal')} · ${q.number}`, lang);
    const share = await shareOf(tx, c.tenantId, attachmentId, (url) => `${q.number} · ${q.title}: ${url}`);
    return { ...share!, clientPhone: q.client.phone };
  });
}

// ─── Status actions ─────────────────────────────────────────────────────────

export async function sendQuote(id: string, input: SendQuoteInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const q = await findQuote(tx, id);
    if (q.status === 'WON' || q.status === 'LOST') throw closed(q);
    if (q.status === 'EXPIRED') throw new Conflict('QUOTE_STATUS_INVALID', 'The quote has expired — add a revision with today’s rates first', { status: q.status });
    const company = await companyQuoteSettings(tx, c.tenantId);
    const validUntil = input.validUntil ?? addDays(today(), company.quoteValidityDays);
    const now = new Date();
    await tx.quote.update({ where: { id }, data: { status: 'SENT', sentAt: now, validUntil: dateOnly(validUntil), lastActivityAt: now } });
    const lang = await documentLang(tx, c.userId, input.lang);
    const share = await customerShare(tx, c, { ...q, validUntil: dateOnly(validUntil) }, lang);
    await audit(tx, c, 'quote.send', id, { number: q.number, revision: q.revision, validUntil, lang, from: q.status, pricePaisa: q.pricePaisa.toString() });
    return { quote: await detail(tx, c, id), share };
  });
}

export async function recordNegotiation(id: string, note: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const q = await findQuote(tx, id);
    if (q.status === 'WON' || q.status === 'LOST') throw closed(q);
    if (q.status !== 'SENT' && q.status !== 'NEGOTIATION') {
      throw new Conflict('QUOTE_STATUS_INVALID', 'Send the quote to the client first', { status: q.status });
    }
    await tx.quote.update({ where: { id }, data: { status: 'NEGOTIATION', lastActivityAt: new Date() } });
    await audit(tx, c, 'quote.negotiation', id, { number: q.number, from: q.status, note });
    return detail(tx, c, id);
  });
}

export async function markLost(id: string, input: LostInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const q = await findQuote(tx, id);
    if (q.status === 'WON' || q.status === 'LOST') throw closed(q);
    if (input.reason === 'OTHER' && !input.note) throw new BadRequest('LOST_NOTE_REQUIRED', 'Write why the quote was lost (reason OTHER)');
    const now = new Date();
    await tx.quote.update({ where: { id }, data: { status: 'LOST', lostAt: now, lostReason: input.reason, lostNote: input.note ?? null, lastActivityAt: now } });
    await audit(tx, c, 'quote.lost', id, { number: q.number, from: q.status, reason: input.reason, ...(input.note ? { note: input.note } : {}) });
    return detail(tx, c, id);
  });
}

const addMonths = (date: string, months: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
};

/** Floor levels a quote's draft project gets (wizard order). */
export function projectLevels(inputs: Pick<QuoteInputs, 'floors' | 'basement' | 'mumty'>) {
  const above = (['GROUND', 'FIRST', 'SECOND', 'THIRD'] as const).slice(0, inputs.floors);
  return [...(inputs.basement ? (['BASEMENT'] as const) : []), ...above, ...(inputs.mumty ? (['MUMTY'] as const) : [])];
}

/**
 * Mark as Won: makes the DRAFT project pre-filled from the latest revision (wizard tabs 1–4) and
 * links it. Idempotent: a WON quote whose project still exists returns it (`created: false`).
 */
export async function markWon(id: string, input: WonInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const q = await findQuote(tx, id);
    if (q.status === 'LOST') throw closed(q);
    if (q.status === 'WON' && q.wonProjectId) {
      const existing = await wonProjectOf(tx, q);
      if (existing) return { quote: await detail(tx, c, id), projectId: existing.id, projectCode: existing.code, created: false };
    }
    const r = await tx.quoteRevision.findFirstOrThrow({ where: { quoteId: id, revision: q.revision } });
    const inputs = r.inputs as unknown as QuoteInputs;
    const stages = r.paymentStages as unknown as PaymentStage[];
    const company = await companyQuoteSettings(tx, c.tenantId);
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: c.tenantId }, select: { slug: true } });
    const template = r.paymentTemplateId ? await tx.paymentScheduleTemplate.findFirst({ where: { id: r.paymentTemplateId }, select: { billingModel: true } }) : null;
    const billingModel = template?.billingModel ?? 'STAGE_SCHEDULE';
    const laborOnly = inputs.contractType === 'LABOR_ONLY';

    const startDate = input.startDate ?? today();
    const endDate = input.endDate ?? addMonths(startDate, QUICK_VALUES['quickProjectMonths']!);
    if (input.code && (await tx.project.findFirst({ where: { code: input.code }, select: { id: true } }))) {
      throw new Conflict('PROJECT_CODE_TAKEN', 'Another project already uses this code');
    }
    const code = input.code ?? (await nextProjectCode(tx, c.tenantId, tenant.slug, Number(startDate.slice(0, 4))));
    const differs = (value: number, def: number) => (value === def ? null : new Prisma.Decimal(value));

    const project = await tx.project.create({
      data: {
        tenantId: c.tenantId,
        code,
        name: input.name ?? q.title,
        clientId: q.clientId,
        siteAddress: q.siteAddress,
        city: q.city,
        startDate: dateOnly(startDate),
        endDate: dateOnly(endDate),
        status: 'DRAFT',
        // Tab 2 — contract: the quote price (labour-only: the rate per sq ft)
        contractType: inputs.contractType,
        billingModel,
        contractValuePaisa: laborOnly ? null : r.pricePaisa,
        ratePerSqftPaisa: laborOnly || billingModel === 'RUNNING_BILLS' ? r.perSqftPaisa : null,
        retentionPercent: 5,
        defectPeriodMonths: 6,
        marginPercent: differs(inputs.marginPercent, company.marginPercent),
        finishingAllowancePercent: inputs.contractType === 'FULL' ? differs(inputs.finishingAllowancePercent, company.finishingAllowancePercent) : null,
        // Tab 3 — plot & structure
        plotUnit: inputs.plot.unit,
        plotSize: inputs.plot.size,
        marlaStandard: inputs.plot.marlaStandard,
        frontFt: inputs.plot.frontFt,
        depthFt: inputs.plot.depthFt,
        structureType: inputs.structureType,
        hasBasement: inputs.basement,
        basementHeightFt: inputs.basement ? inputs.basementHeightFt : null,
        // Tab 4 — coverage
        coveredAreaSqft: inputs.coveredAreaSqft,
        wizardCompletedSteps: [1, 2, 3, 4],
        createdFromQuoteId: q.id,
        createdById: c.userId,
      },
    });
    // Supply split with the quote's quality category
    const split = supplySplit(inputs.contractType, inputs.supplyRules);
    await tx.projectSupplyRule.createMany({
      data: split.map((s) => ({
        tenantId: c.tenantId,
        projectId: project.id,
        categoryKey: s.categoryKey,
        suppliedBy: s.suppliedBy,
        qualityCategoryId: s.suppliedBy === 'CONTRACTOR' ? inputs.qualityCategoryId : null,
      })),
    });
    await tx.projectBillingStage.createMany({
      data: stages.map((s, i) => ({ tenantId: c.tenantId, projectId: project.id, sortOrder: i + 1, label: s.label, percent: s.percent, isRetention: s.isRetention })),
    });
    await recomputeStageAmounts(tx, project.id);
    for (const level of projectLevels(inputs)) {
      await tx.floor.create({
        data: {
          tenantId: c.tenantId,
          projectId: project.id,
          level,
          name: FLOOR_NAMES[level],
          ceilingHeightFt: quickCeiling(level, QUICK_VALUES, inputs.basementHeightFt),
          sortOrder: FLOOR_LEVELS.indexOf(level) + 1,
        },
      });
    }
    if (c.role !== 'THEKEDAR') await tx.userProjectAccess.create({ data: { tenantId: c.tenantId, userId: c.userId, projectId: project.id } });

    const now = new Date();
    await tx.quote.update({ where: { id }, data: { status: 'WON', wonAt: q.wonAt ?? now, wonProjectId: project.id, lastActivityAt: now } });
    await projectAudit(tx, c, 'project.create', project.id, { code, name: project.name, fromQuoteId: q.id, quoteNumber: q.number });
    await audit(tx, c, 'quote.won', id, { number: q.number, from: q.status, revision: r.revision, projectId: project.id, projectCode: code, pricePaisa: r.pricePaisa.toString() });
    return { quote: await detail(tx, c, id), projectId: project.id, projectCode: code, created: true };
  });
}

// ─── Win / loss insights ────────────────────────────────────────────────────

const monthKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);

export async function insights(months: number) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const fa = fieldsOf(c);
    const now = new Date();
    const to = today();
    const [y, m] = to.split('-').map(Number) as [number, number];
    const first = new Date(Date.UTC(y, m - 1 - (months - 1), 1));
    const from = first.toISOString().slice(0, 10);
    const since = new Date(first.getTime() - 5 * 3_600_000); // 00:00 PKT
    const rows = await tx.quote.findMany({
      where: { OR: [{ createdAt: { gte: since } }, { wonAt: { gte: since } }, { lostAt: { gte: since } }] },
      select: { status: true, createdAt: true, sentAt: true, wonAt: true, lostAt: true, lostReason: true, pricePaisa: true, perSqftPaisa: true },
    });
    const created = rows.filter((r) => r.createdAt >= since);
    const count = (s: string) => created.filter((r) => r.status === s).length;
    const totals = {
      quotes: created.length,
      sent: created.filter((r) => r.sentAt !== null).length,
      won: count('WON'),
      lost: count('LOST'),
      expired: count('EXPIRED'),
      open: created.filter((r) => r.status === 'DRAFT' || r.status === 'SENT' || r.status === 'NEGOTIATION').length,
    };
    const decided = totals.won + totals.lost + totals.expired;
    const monthsList: string[] = [];
    for (let i = 0; i < months; i++) monthsList.push(new Date(Date.UTC(y, m - 1 - (months - 1) + i, 1)).toISOString().slice(0, 7));
    const perMonth = monthsList.map((month) => ({
      month,
      created: rows.filter((r) => r.createdAt >= since && monthKey(r.createdAt) === month).length,
      won: rows.filter((r) => r.wonAt && r.wonAt >= since && monthKey(r.wonAt) === month).length,
      lost: rows.filter((r) => r.lostAt && r.lostAt >= since && monthKey(r.lostAt) === month).length,
    }));
    const lostRows = created.filter((r) => r.status === 'LOST');
    const lossReasons = (['COMPETITOR_CHEAPER', 'CLIENT_POSTPONED', 'SELF_BUILD', 'OTHER'] as const).map((reason) => ({ reason, count: lostRows.filter((r) => r.lostReason === reason).length }));
    const avg = (xs: Array<bigint | null>) => {
      const v = xs.filter((x): x is bigint => x !== null);
      return v.length ? ((v.reduce((a, b) => a + b, 0n) * 2n + BigInt(v.length)) / (2n * BigInt(v.length))).toString() : null;
    };
    const follow = await tx.quote.findMany({
      where: { status: 'SENT', lastActivityAt: { lt: new Date(now.getTime() - FOLLOW_UP_DAYS * DAY_MS) } },
      include: quoteInclude,
      orderBy: { lastActivityAt: 'asc' },
      take: 50,
    });
    return {
      from,
      to,
      months,
      totals,
      winRate: decided ? Math.round((totals.won / decided) * 10_000) / 100 : null,
      perMonth,
      lossReasons,
      followUps: follow.map((q) => summaryDto(q, fa, null, now)),
      ...(fa.contract
        ? {
            avgRateQuotedPaisa: avg(created.filter((r) => r.sentAt !== null || r.status === 'WON').map((r) => r.perSqftPaisa)),
            avgRateWonPaisa: avg(created.filter((r) => r.status === 'WON').map((r) => r.perSqftPaisa)),
            wonValuePaisa: created.filter((r) => r.status === 'WON').reduce((a, r) => a + r.pricePaisa, 0n).toString(),
            pipelineValuePaisa: created.filter((r) => r.status === 'SENT' || r.status === 'NEGOTIATION').reduce((a, r) => a + r.pricePaisa, 0n).toString(),
          }
        : {}),
    };
  });
}

