import type { AttachmentKind, Prisma } from '../../generated/prisma/client.js';

type Db = Prisma.TransactionClient;

export function createAttachment(
  tx: Db,
  data: {
    id: string;
    tenantId: string;
    kind: AttachmentKind;
    storageKey: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    uploadedById: string;
    clientId?: string | null;
  },
) {
  return tx.attachment.create({ data });
}

export function findByClientId(tx: Db, tenantId: string, clientId: string) {
  return tx.attachment.findUnique({ where: { tenantId_clientId: { tenantId, clientId } } });
}

/** RLS limits this to the current tenant: another company's id returns null. */
export function findAttachment(tx: Db, id: string) {
  return tx.attachment.findUnique({ where: { id } });
}
