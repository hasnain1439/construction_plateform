import type { Tx } from '../../core/db/withTenant.js';
import type { Prisma } from '../../generated/prisma/client.js';

export function clientWhere(search?: string): Prisma.ClientWhereInput {
  if (!search) return {};
  const digits = search.replace(/\D/g, '').replace(/^0+/, '').replace(/^92/, '');
  return {
    OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
    ],
  };
}

export function listClients(tx: Tx, where: Prisma.ClientWhereInput, skip: number, take: number) {
  return tx.client.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip, take });
}

export function countClients(tx: Tx, where: Prisma.ClientWhereInput) {
  return tx.client.count({ where });
}

export function findClient(tx: Tx, id: string) {
  return tx.client.findUnique({ where: { id } });
}

export function findClientByPhone(tx: Tx, phone: string) {
  return tx.client.findFirst({ where: { phone } });
}
