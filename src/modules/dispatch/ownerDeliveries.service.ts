/** Material the owner (client) delivers to the site himself: OWNER_DELIVERY_IN at cost 0. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { optionalSignedUrl } from '../attachments/attachments.service.js';
import {
  actor,
  assertAttachment,
  audit,
  isOwnerSupplied,
  loadMaterials,
  lockLocations,
  materialRef,
  occurredAtFor,
  ownerSuppliedCategories,
  postIn,
  qn,
  siteLocation,
  type Actor,
} from '../inventory/stock.js';
import { STOCK_OPEN_STATUSES } from '../inventory/usage.service.js';
import { assertEditable, findProjectFor } from '../projects/access.js';
import type { OwnerDeliveriesQuery, OwnerDeliveryInput } from './dispatch.schema.js';

const deliveryInclude = {
  items: { include: { material: { select: { id: true, name: true, unit: true } } } },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.OwnerDeliveryInclude;

type DeliveryRow = Prisma.OwnerDeliveryGetPayload<{ include: typeof deliveryInclude }>;

async function toDeliveryDto(tx: Tx, d: DeliveryRow) {
  const photos = await tx.attachment.findMany({ where: { tenantId: d.tenantId, id: { in: d.photoAttachmentIds } }, select: { id: true, storageKey: true } });
  return {
    id: d.id,
    projectId: d.projectId,
    deliveryDate: formatDateOnly(d.deliveryDate),
    note: d.note,
    items: d.items.map((i) => ({ material: materialRef(i.material), qty: qn(i.qty) })),
    photos: await Promise.all(photos.map(async (p) => ({ id: p.id, url: await optionalSignedUrl(p) }))),
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
  };
}

export async function createOwnerDeliveryTx(tx: Tx, a: Actor, projectId: string, input: OwnerDeliveryInput, opts: { at?: Date } = {}) {
  const project = await findProjectFor(tx, a, projectId);
  assertEditable(project, [...STOCK_OPEN_STATUSES]);
  const site = await siteLocation(tx, a.tenantId, project);
  const materials = await loadMaterials(tx, a.tenantId, input.items.map((i) => i.materialId));
  const ownerCats = await ownerSuppliedCategories(tx, a.tenantId, project.id);
  const notOwner = input.items.filter((i) => !isOwnerSupplied(materials.get(i.materialId)!, ownerCats)).map((i) => i.materialId);
  if (notOwner.length) {
    throw new BadRequest('NOT_OWNER_SUPPLIED', `The owner doesn’t supply ${notOwner.map((id) => materials.get(id)!.name).join(', ')} on this project`, { materialIds: notOwner });
  }
  for (const id of input.photoAttachmentIds) await assertAttachment(tx, a.tenantId, id, ['SITE_PHOTO', 'DOCUMENT'], 'INVALID_ATTACHMENT', 'Photo');
  const at = opts.at ?? occurredAtFor(input.deliveryDate);

  await lockLocations(tx, [site.id]);
  const delivery = await tx.ownerDelivery.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      locationId: site.id,
      deliveryDate: dateOnly(input.deliveryDate),
      note: input.note ?? null,
      photoAttachmentIds: input.photoAttachmentIds,
      createdById: a.userId,
      items: { create: input.items.map((i) => ({ materialId: i.materialId, qty: i.qty })) },
    },
  });
  for (const i of input.items) {
    await postIn(tx, a.tenantId, { locationId: site.id, materialId: i.materialId, ownerSupplied: true }, i.qty, 0n, {
      type: 'OWNER_DELIVERY_IN',
      refType: 'OWNER_DELIVERY',
      refId: delivery.id,
      occurredAt: at,
      createdById: a.userId,
    });
  }
  await audit(tx, a, 'stock.owner_delivery', 'OwnerDelivery', delivery.id, {
    projectId: project.id,
    deliveryDate: input.deliveryDate,
    items: input.items.map((i) => ({ materialId: i.materialId, qty: qn(i.qty) })),
  });
  return toDeliveryDto(tx, await tx.ownerDelivery.findUniqueOrThrow({ where: { id: delivery.id }, include: deliveryInclude }));
}

export async function createOwnerDelivery(projectId: string, input: OwnerDeliveryInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createOwnerDeliveryTx(tx, a, projectId, input));
}

export async function listOwnerDeliveries(projectId: string, query: OwnerDeliveriesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await findProjectFor(tx, a, projectId);
    const where: Prisma.OwnerDeliveryWhereInput = { tenantId: a.tenantId, projectId: project.id };
    const rows = await tx.ownerDelivery.findMany({ where, include: deliveryInclude, orderBy: [{ deliveryDate: 'desc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.ownerDelivery.count({ where });
    const data = [];
    for (const d of rows) data.push(await toDeliveryDto(tx, d));
    return { data, meta: pageMeta(query, total) };
  });
}
