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
  },
) {
  return tx.attachment.create({ data });
}

/** RLS limits this to the current tenant: another company's id returns null. */
export function findAttachment(tx: Db, id: string) {
  return tx.attachment.findUnique({ where: { id } });
}
