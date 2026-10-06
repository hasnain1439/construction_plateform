import { prismaAdmin } from '../../src/core/db/prisma.js';
import { setPdfRenderer } from '../../src/core/pdf/renderer.js';
import { todayIn } from '../../src/core/utils/dates.js';
import { api, attachment, owner, pm, rs, type Auth } from '../inventory/fixtures.js';
import { bearer, loginMobile, SEED } from '../helpers.js';

export { api, attachment, owner, pm, rs, type Auth };

export const today = () => todayIn('Asia/Karachi');
export const daysAgo = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** PDFs in tests: a tiny fake PDF, and the HTML each call was given. */
export const pdfCalls: Array<{ html: string; footer: string }> = [];
export function mockPdf(fail = false) {
  pdfCalls.length = 0;
  setPdfRenderer({
    async render(html, { footerText }) {
      pdfCalls.push({ html, footer: footerText });
      if (fail) throw new Error('chromium missing');
      return Buffer.from('%PDF-1.4 test');
    },
  });
}

export async function stagesOf(projectId: string) {
  return prismaAdmin.projectBillingStage.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } });
}

/** A PM who may see money (billing.view). */
export async function pmWithFinancials(tenantId: string): Promise<Auth> {
  await prismaAdmin.user.updateMany({ where: { tenantId, phone: SEED.malik.pm.phone }, data: { canSeeFinancials: true } });
  return bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
}

/** Marks a stage ready (with a photo). */
export async function markReady(auth: Auth, stageId: string) {
  const photo = await attachment(auth, 'SITE_PHOTO');
  const res = await api().post(`/api/v1/billing-stages/${stageId}/mark-ready`).set(auth).send({ proofAttachmentIds: [photo] });
  if (res.status !== 200) throw new Error(`mark-ready ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Draft + issue an invoice for a stage (forced when not ready). */
export async function stageInvoice(auth: Auth, projectId: string, stageId: string, issueDate?: string) {
  const draft = await api().post(`/api/v1/projects/${projectId}/invoices`).set(auth).send({ type: 'STAGE', billingStageId: stageId, force: true, forceNote: 'test invoice' });
  if (draft.status !== 201) throw new Error(`draft ${draft.status} ${JSON.stringify(draft.body)}`);
  const issued = await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(auth).send(issueDate ? { issueDate } : {});
  if (issued.status !== 200) throw new Error(`issue ${issued.status} ${JSON.stringify(issued.body)}`);
  return issued.body.data as { id: string; number: string; totalPaisa: string; dueDate: string; status: string };
}

export async function pay(auth: Auth, projectId: string, body: Record<string, unknown>) {
  return api()
    .post(`/api/v1/projects/${projectId}/payments`)
    .set(auth)
    .send({ receivedOn: today(), method: 'BANK_TRANSFER', ...body });
}
