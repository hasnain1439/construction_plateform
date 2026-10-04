import { writeAudit } from '../../core/audit/audit.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { Project } from '../../generated/prisma/client.js';
import { createClientTx } from '../clients/clients.service.js';
import { caller, findEditableProject, findProjectFor, projectNotFound, projectScope, type Caller } from './access.js';
import { nextProjectCode } from './code.js';
import { toDetailDto, toListDto } from './projects.dto.js';
import * as repo from './projects.repository.js';
import type { CreateProjectInput, ListProjectsQuery, SetTeamInput, UpdateBasicInput } from './projects.schema.js';

// ─── Shared helpers (used by the wizard / rooms / review services too) ─────

export function audit(tx: Tx, c: Caller, action: string, projectId: string, details?: Prisma.InputJsonValue) {
  return writeAudit(tx, {
    tenantId: c.tenantId,
    actorType: 'USER',
    actorId: c.userId,
    action,
    entityType: 'Project',
    entityId: projectId,
    ...(details === undefined ? {} : { details }),
  });
}

export async function detail(tx: Tx, c: Caller, id: string) {
  return toDetailDto(await repo.loadFull(tx, id), c);
}

/** Records a finished wizard tab (1–5). */
export async function markStep(tx: Tx, project: Pick<Project, 'id' | 'wizardCompletedSteps'>, step: number) {
  if (project.wizardCompletedSteps.includes(step)) return;
  await tx.project.update({ where: { id: project.id }, data: { wizardCompletedSteps: { push: step } } });
}

export const codeTaken = (err: unknown): never => {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = String((err.meta as { target?: unknown } | undefined)?.target ?? '');
    if (target.includes('code') || target === '') throw new Conflict('PROJECT_CODE_TAKEN', 'Another project already uses this code');
  }
  throw err;
};

async function resolveClient(tx: Tx, input: { clientId?: string | undefined; newClient?: CreateProjectInput['newClient'] }) {
  if (input.newClient) return (await createClientTx(tx, input.newClient)).id;
  if (input.clientId) {
    if (!(await tx.client.findUnique({ where: { id: input.clientId }, select: { id: true } }))) {
      throw new BadRequest('INVALID_CLIENT', 'Client not found in this company');
    }
    return input.clientId;
  }
  return undefined;
}

async function assertCodeFree(tx: Tx, code: string, exceptId?: string) {
  const clash = await tx.project.findFirst({ where: { code, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (clash) throw new Conflict('PROJECT_CODE_TAKEN', 'Another project already uses this code');
}

async function assertRole(tx: Tx, ids: string[], role: 'PM' | 'MUNSHI') {
  const found = new Set((await repo.activeUsersWithRole(tx, ids, role)).map((u) => u.id));
  const invalid = ids.filter((id) => !found.has(id));
  if (invalid.length) {
    throw new BadRequest(role === 'PM' ? 'INVALID_PM' : 'INVALID_MUNSHI', `Not an active ${role} of this company`, { userIds: invalid });
  }
}

// ─── List / detail ──────────────────────────────────────────────────────────

export async function listProjects(query: ListProjectsQuery) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const and: Prisma.ProjectWhereInput[] = [projectScope(c)];
    if (query.search) {
      and.push({
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { code: { contains: query.search, mode: 'insensitive' } },
          { client: { name: { contains: query.search, mode: 'insensitive' } } },
        ],
      });
    }
    if (query.status) and.push({ status: query.status });
    if (query.contractType) and.push({ contractType: query.contractType });
    if (query.pmId) and.push({ userAccess: { some: { userId: query.pmId } } });
    const where: Prisma.ProjectWhereInput = { AND: and };
    const rows = await tx.project.findMany({
      where,
      include: repo.projectListInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      ...skipTake(query),
    });
    return { data: rows.map((p) => toListDto(p, c)), meta: pageMeta(query, await tx.project.count({ where })) };
  });
}

export async function getProject(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    await findProjectFor(tx, c, id);
    return detail(tx, c, id);
  });
}

// ─── Create (tab 1) ─────────────────────────────────────────────────────────

export async function createProject(input: CreateProjectInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: c.tenantId }, select: { slug: true, settings: { select: { marlaStandardSqft: true } } } });
    if (input.pmId) await assertRole(tx, [input.pmId], 'PM');
    if (input.munshiId) await assertRole(tx, [input.munshiId], 'MUNSHI');
    const clientId = await resolveClient(tx, input);
    const code = input.code ?? (await nextProjectCode(tx, c.tenantId, tenant.slug, Number(input.startDate.slice(0, 4))));
    if (input.code) await assertCodeFree(tx, code);

    const project = await tx.project.create({
      data: {
        tenantId: c.tenantId,
        code,
        name: input.name,
        clientId: clientId ?? null,
        siteAddress: input.siteAddress,
        city: input.city,
        startDate: dateOnly(input.startDate),
        endDate: dateOnly(input.endDate),
        status: 'DRAFT',
        marlaStandard: tenant.settings?.marlaStandardSqft ?? 225,
        retentionPercent: 5,
        defectPeriodMonths: 6,
        wizardCompletedSteps: [1],
        createdById: c.userId,
      },
    });
    // Team: chosen PM / Munshi, and a PM creator is always assigned
    const members = new Set([input.pmId, input.munshiId, c.role === 'PM' ? c.userId : undefined].filter((x): x is string => Boolean(x)));
    if (members.size) {
      await tx.userProjectAccess.createMany({ data: [...members].map((userId) => ({ tenantId: c.tenantId, userId, projectId: project.id })), skipDuplicates: true });
    }
    await audit(tx, c, 'project.create', project.id, { code, name: project.name });
    return detail(tx, c, project.id);
  }).catch(codeTaken);
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteProject(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await findProjectFor(tx, c, id);
    if (project.status !== 'DRAFT') throw new Conflict('PROJECT_NOT_DRAFT', 'Only draft projects can be deleted', { status: project.status });
    await tx.project.delete({ where: { id } }); // floors, rooms, openings, stages, rules, access cascade
    await audit(tx, c, 'project.delete', id, { code: project.code, name: project.name });
    return { id, deleted: true };
  });
}

// ─── Tab 1 edit + team ──────────────────────────────────────────────────────

export async function updateBasic(id: string, input: UpdateBasicInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await findEditableProject(tx, c, id);
    const start = input.startDate ?? (project.startDate ? project.startDate.toISOString().slice(0, 10) : undefined);
    const end = input.endDate ?? (project.endDate ? project.endDate.toISOString().slice(0, 10) : undefined);
    if (start && end && end < start) throw new BadRequest('INVALID_DATES', 'endDate must be on or after startDate');
    if (input.code && input.code !== project.code) await assertCodeFree(tx, input.code, id);
    const clientId = await resolveClient(tx, input);

    await tx.project.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(clientId !== undefined ? { clientId } : {}),
        ...(input.siteAddress !== undefined ? { siteAddress: input.siteAddress } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.startDate !== undefined ? { startDate: dateOnly(input.startDate) } : {}),
        ...(input.endDate !== undefined ? { endDate: dateOnly(input.endDate) } : {}),
      },
    });
    await markStep(tx, project, 1);
    const fields = Object.keys(input).filter((k) => input[k as keyof UpdateBasicInput] !== undefined);
    await audit(tx, c, 'project.update_basic', id, { fields });
    return detail(tx, c, id);
  }).catch(codeTaken);
}

export async function setTeam(id: string, input: SetTeamInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await findEditableProject(tx, c, id, ['DRAFT', 'ACTIVE', 'CLOSEOUT']);
    if (input.pmId) await assertRole(tx, [input.pmId], 'PM');
    if (input.munshiIds?.length) await assertRole(tx, input.munshiIds, 'MUNSHI');

    const replace = async (role: 'PM' | 'MUNSHI', userIds: string[]) => {
      await tx.userProjectAccess.deleteMany({ where: { projectId: id, user: { role } } });
      if (userIds.length) {
        await tx.userProjectAccess.createMany({ data: userIds.map((userId) => ({ tenantId: c.tenantId, userId, projectId: id })), skipDuplicates: true });
      }
    };
    if (input.pmId !== undefined) await replace('PM', input.pmId ? [input.pmId] : []);
    if (input.munshiIds !== undefined) await replace('MUNSHI', input.munshiIds);
    await audit(tx, c, 'project.team_update', id, { code: project.code, pmId: input.pmId ?? null, munshiIds: input.munshiIds ?? null });
    return detail(tx, c, id);
  });
}

export { projectNotFound };
