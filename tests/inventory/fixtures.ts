import { prismaAdmin } from '../../src/core/db/prisma.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { D, postIn, siteLocation, systemLocations } from '../../src/modules/inventory/stock.js';
import { api, bearer, loginMobile, loginMunshi, pngBytes, SEED, upload } from '../helpers.js';

export type Auth = Record<string, string>;

export const owner = async (): Promise<Auth> => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
export const pm = async (): Promise<Auth> => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
/** Rafaqat (MUNSHI on DHA). */
export const munshi = async (tenantId: string): Promise<Auth> => bearer((await loginMunshi(tenantId)).accessToken);

export async function materialId(tenantId: string, name: string) {
  return (await prismaAdmin.material.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name } } })).id;
}

export async function supplierId(tenantId: string, name: string) {
  return (await prismaAdmin.supplier.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name } } })).id;
}

export async function storeOf(tenantId: string) {
  return prismaAdmin.$transaction((tx) => systemLocations(tx, tenantId));
}

export async function siteOf(tenantId: string, projectId: string) {
  const project = await prismaAdmin.project.findUniqueOrThrow({ where: { id: projectId } });
  return prismaAdmin.$transaction((tx) => siteLocation(tx, tenantId, project));
}

/** Puts stock straight into a location (bypassing documents) for tests of reading / taking stock. */
export async function stockIn(tenantId: string, locationId: string, materialId: string, qty: number | string, ratePaisa: bigint, ownerSupplied = false, occurredAt = new Date()) {
  return prismaAdmin.$transaction((tx) =>
    postIn(tx, tenantId, { locationId, materialId, ownerSupplied }, D(qty), ratePaisa, {
      type: ownerSupplied ? 'OWNER_DELIVERY_IN' : 'PURCHASE_IN',
      refType: 'TEST',
      refId: uuidv7(),
      occurredAt,
      createdById: null,
    }),
  );
}

/** Uploads a PNG as `kind` and returns its id. */
export async function attachment(auth: Auth, kind: 'CHALLAN' | 'SITE_PHOTO' | 'RECEIPT' | 'DOCUMENT' = 'CHALLAN') {
  const res = await upload(auth.Authorization!.slice(7), kind, pngBytes(), 'challan.png');
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

export const rs = (rupees: number) => String(Math.round(rupees * 100));
export { api };
