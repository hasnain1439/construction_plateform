import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import type { Client } from '../../generated/prisma/client.js';
import { caller, projectScope } from '../projects/access.js';
import * as repo from './clients.repository.js';
import type { CreateClientInput, ListClientsQuery, UpdateClientInput } from './clients.schema.js';

function current() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId! };
}

const notFound = () => new NotFound('CLIENT_NOT_FOUND', 'Client not found');
const phoneTaken = (err: unknown): never => {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new Conflict('CLIENT_PHONE_TAKEN', 'Another client already has this phone number');
  }
  throw err;
};

export function toClientDto(c: Client) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    address: c.address,
    notes: c.notes,
    createdAt: c.createdAt.toISOString(),
  };
}

function audit(tx: Tx, action: string, entityId: string, details: Prisma.InputJsonValue) {
  const { tenantId, userId } = current();
  return writeAudit(tx, { tenantId, actorType: 'USER', actorId: userId, action, entityType: 'Client', entityId, details });
}

/** Creates a client inside an existing transaction (also used by project tab 1 `newClient`). */
export async function createClientTx(tx: Tx, input: CreateClientInput) {
  const { tenantId, userId } = current();
  if (await repo.findClientByPhone(tx, input.phone)) throw new Conflict('CLIENT_PHONE_TAKEN', 'Another client already has this phone number');
  const client = await tx.client.create({
    data: {
      tenantId,
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      address: input.address ?? null,
      notes: input.notes ?? null,
      createdById: userId,
    },
  });
  await audit(tx, 'client.create', client.id, { name: client.name });
  return client;
}

export async function listClients(query: ListClientsQuery) {
  return withTenant(current().tenantId, async (tx) => {
    const where = repo.clientWhere(query.search);
    const { skip, take } = skipTake(query);
    const rows = await repo.listClients(tx, where, skip, take);
    const total = await repo.countClients(tx, where);
    // Counts only projects the caller can see (a PM sees their assigned ones)
    const counts = rows.length
      ? await tx.project.groupBy({ by: ['clientId'], where: { clientId: { in: rows.map((r) => r.id) }, ...projectScope(caller()) }, _count: { _all: true } })
      : [];
    const byClient = new Map(counts.map((c) => [c.clientId, c._count._all]));
    return { data: rows.map((c) => ({ ...toClientDto(c), projectsCount: byClient.get(c.id) ?? 0 })), meta: pageMeta(query, total) };
  });
}

export async function getClient(id: string) {
  return withTenant(current().tenantId, async (tx) => {
    const client = await repo.findClient(tx, id);
    if (!client) throw notFound();
    const projects = await tx.project.findMany({
      where: { clientId: id, ...projectScope(caller()) },
      select: { id: true, code: true, name: true, status: true, city: true, startDate: true, endDate: true },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    });
    return {
      ...toClientDto(client),
      projects: projects.map((p) => ({
        ...p,
        startDate: p.startDate?.toISOString().slice(0, 10) ?? null,
        endDate: p.endDate?.toISOString().slice(0, 10) ?? null,
      })),
    };
  });
}

export async function createClient(input: CreateClientInput) {
  return withTenant(current().tenantId, async (tx) => toClientDto(await createClientTx(tx, input))).catch(phoneTaken);
}

export async function updateClient(id: string, input: UpdateClientInput) {
  return withTenant(current().tenantId, async (tx) => {
    if (!(await repo.findClient(tx, id))) throw notFound();
    const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Prisma.ClientUpdateInput;
    const updated = await tx.client.update({ where: { id }, data });
    await audit(tx, 'client.update', id, { name: updated.name, fields: Object.keys(data) });
    return toClientDto(updated);
  }).catch(phoneTaken);
}
