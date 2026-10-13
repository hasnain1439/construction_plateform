/**
 * Who may see / change which project.
 *   THEKEDAR – every project.
 *   Others   – projects in UserProjectAccess (creators are auto-assigned), or every project when
 *              the permission in question has scope ALL_PROJECTS (default: projects.project.view).
 *   Site accounts without projects.project.edit get the basic view.
 * A project outside the caller's reach is always 404 (never 403), so its existence isn't leaked.
 */
import { assertPerm, can, fieldAccess, scopeAll, type FieldAccess } from '../../core/auth/access.js';
import { getCtx } from '../../core/context/requestContext.js';
import type { Tx } from '../../core/db/withTenant.js';
import { Conflict, NotFound } from '../../core/errors/AppError.js';
import type { Prisma, Project, ProjectStatus } from '../../generated/prisma/client.js';

export interface Caller {
  tenantId: string;
  userId: string;
  role: 'THEKEDAR' | 'PM' | 'MUNSHI';
  /** fields.amounts — billing money */
  seesFinancials: boolean;
  /** Field permissions of the caller (contract values: fields.contract). Defaults to the request user's. */
  fields?: FieldAccess;
}

export function caller(): Caller {
  const ctx = getCtx();
  return {
    tenantId: ctx.tenantId!,
    userId: ctx.userId!,
    role: ctx.role as Caller['role'],
    seesFinancials: fieldAccess().amounts,
    fields: fieldAccess(),
  };
}

/** Prisma filter limiting projects to what the caller may see for `perm` (default projects.project.view). */
export function projectScope(c: Pick<Caller, 'userId' | 'role'>, perm = 'projects.project.view'): Prisma.ProjectWhereInput {
  return scopeAll(perm, c) ? {} : { userAccess: { some: { userId: c.userId } } };
}

export const projectNotFound = () => new NotFound('PROJECT_NOT_FOUND', 'Project not found');

export async function findProjectFor(tx: Tx, c: Pick<Caller, 'tenantId' | 'userId' | 'role'>, id: string, perm?: string): Promise<Project> {
  const project = await tx.project.findFirst({ where: { tenantId: c.tenantId, id, ...projectScope(c, perm) } });
  if (!project) throw projectNotFound();
  return project;
}

/**
 * THE project-scope check for services: the caller must hold `perm` (403 PERMISSION_DENIED) and
 * the project must be in its scope — ALL_PROJECTS, or assigned to the caller (404 otherwise).
 */
export async function assertProjectScope(tx: Tx, perm: string, projectId: string, c: Pick<Caller, 'tenantId' | 'userId' | 'role'> = caller()): Promise<Project> {
  assertPerm(perm, c);
  return findProjectFor(tx, c, projectId, perm);
}

/** Wizard sections, rooms and openings can change only while DRAFT or ACTIVE. */
export const EDITABLE_STATUSES: ProjectStatus[] = ['DRAFT', 'ACTIVE'];

export function assertEditable(project: Pick<Project, 'status'>, allowed: ProjectStatus[] = EDITABLE_STATUSES) {
  if (!allowed.includes(project.status)) {
    throw new Conflict('PROJECT_LOCKED', `This project is ${project.status.replace('_', ' ').toLowerCase()} and can't be edited`, { status: project.status });
  }
}

/** Finds a project the caller may edit (projects.project.edit in scope) in an editable status. */
export async function findEditableProject(tx: Tx, c: Caller, id: string, allowed?: ProjectStatus[]) {
  if (!can('projects.project.edit', c)) throw projectNotFound(); // routes check the permission already; belt and braces
  const project = await findProjectFor(tx, c, id, 'projects.project.edit');
  assertEditable(project, allowed);
  return project;
}
