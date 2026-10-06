import { prismaAdmin } from '../../src/core/db/prisma.js';
import { todayIn } from '../../src/core/utils/dates.js';
import { addDays, weekOf } from '../../src/modules/labor/labor.shared.js';
import { api, type Auth } from '../inventory/fixtures.js';

export { api, attachment, materialId, munshi, owner, pm, rs, siteOf, stockIn, storeOf, supplierId, type Auth } from '../inventory/fixtures.js';

export const today = () => todayIn('Asia/Karachi');
/** Monday of the current week / the week before. */
export const thisWeek = () => weekOf(today(), 'MONDAY').weekStart;
export const lastWeek = () => addDays(thisWeek(), -7);
export { addDays };

export async function workerId(tenantId: string, name: string) {
  return (await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId, name } })).id;
}

export async function subcontractorId(tenantId: string, name: string) {
  return (await prismaAdmin.subcontractor.findFirstOrThrow({ where: { tenantId, name } })).id;
}

/** Assigns a worker to the project (office) and returns the ProjectWorker row. */
export async function assign(auth: Auth, projectId: string, workerId: string, dailyRatePaisa?: string, startDate?: string) {
  const res = await api()
    .post(`/api/v1/projects/${projectId}/labor/workers`)
    .set(auth)
    .send({ workerId, ...(dailyRatePaisa ? { dailyRatePaisa } : {}), ...(startDate ? { startDate } : {}) });
  if (res.status !== 201) throw new Error(`assign failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; dailyRatePaisa: string };
}

export async function mark(auth: Auth, projectId: string, date: string, entries: Array<{ workerId: string; status: 'FULL' | 'HALF' | 'ABSENT'; overtimeHours?: number }>) {
  return api().post(`/api/v1/projects/${projectId}/attendance`).set(auth).send({ date, entries });
}

/** THEKEDAR sends a float; the holder acknowledges it (when `holderAuth` is given). */
export async function float(ownerAuth: Auth, holderUserId: string, amountPaisa: string, holderAuth?: Auth) {
  const res = await api().post('/api/v1/cash-floats').set(ownerAuth).send({ holderUserId, amountPaisa, method: 'EASYPAISA', reference: 'EP1001' });
  if (res.status !== 201) throw new Error(`float failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (holderAuth) {
    const ack = await api().post(`/api/v1/cash-floats/${res.body.data.id}/acknowledge`).set(holderAuth);
    if (ack.status !== 200) throw new Error(`ack failed: ${ack.status} ${JSON.stringify(ack.body)}`);
  }
  return res.body.data as { id: string; accountId: string };
}

export async function balanceOf(auth: Auth, accountId: string) {
  return (await api().get(`/api/v1/cash-accounts/${accountId}`).set(auth)).body.data.balancePaisa as string;
}
