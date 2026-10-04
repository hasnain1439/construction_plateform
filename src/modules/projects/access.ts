/**
 * Who may see / change which project.
 *   THEKEDAR – every project.
 *   PM       – projects in UserProjectAccess (creators are auto-assigned).
 *   MUNSHI   – assigned projects, read-only, basic fields.
 * A project outside the caller's reach is always 404 (never 403), so its existence isn't leaked.
 */
import { getCtx } from '../../core/context/requestContext.js';
import type { Tx } from '../../core/db/withTenant.js';
import { Conflict, NotFound } from '../../core/errors/AppError.js';
import type { Prisma, Project, ProjectStatus } from '../../generated/prisma/client.js';

export interface Caller {
  tenantId: string;
  userId: string;
  role: 'THEKEDAR' | 'PM' | 'MUNSHI';
  /** billing.view → contract value, rate and stage amounts are included */
  seesFinancials: boolean;
}

export function caller(): Caller {
  const ctx = getCtx();
  return {
    tenantId: ctx.tenantId!,
    userId: ctx.userId!,
    role: ctx.role as Caller['role'],
    seesFinancials: ctx.permissions.includes('billing.view'),
  };
}

/** Prisma filter limiting projects to what the caller may see. */
export function projectScope(c: Caller): Prisma.ProjectWhereInput {
  return c.role === 'THEKEDAR' ? {} : { userAccess: { some: { userId: c.userId } } };
}

export const projectNotFound = () => new NotFound('PROJECT_NOT_FOUND', 'Project not found');

export async function findProjectFor(tx: Tx, c: Caller, id: string): Promise<Project> {
  const project = await tx.project.findFirst({ where: { id, ...projectScope(c) } });
  if (!project) throw projectNotFound();
  return project;
}

/** Wizard sections, rooms and openings can change only while DRAFT or ACTIVE. */
export const EDITABLE_STATUSES: ProjectStatus[] = ['DRAFT', 'ACTIVE'];

export function assertEditable(project: Pick<Project, 'status'>, allowed: ProjectStatus[] = EDITABLE_STATUSES) {
  if (!allowed.includes(project.status)) {
    throw new Conflict('PROJECT_LOCKED', `This project is ${project.status.replace('_', ' ').toLowerCase()} and can't be edited`, { status: project.status });
  }
}

/** Finds a project the caller may edit (THEKEDAR, or an assigned PM) in an editable status. */
export async function findEditableProject(tx: Tx, c: Caller, id: string, allowed?: ProjectStatus[]) {
  if (c.role === 'MUNSHI') throw projectNotFound(); // routes block MUNSHI already; belt and braces
  const project = await findProjectFor(tx, c, id);
  assertEditable(project, allowed);
  return project;
}
