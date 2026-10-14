import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { assertApprovalLimit, defaultAccess, resolveAccess } from '../../src/core/auth/access.js';
import { FINANCIAL_BUNDLE, OWNER_ONLY_KEYS, PERMISSION_CATALOG, ROLE_TEMPLATES } from '../../src/core/auth/permissionCatalog.js';
import { provisionPermissions } from '../../src/modules/permissions/provision.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { useFreshDatabase } from '../helpers.js';
import { api, float, munshi, owner, pm, rs, type Auth } from '../labor/fixtures.js';

const seeded = useFreshDatabase();

const overrides = (auth: Auth, userId: string, list: unknown[]) => api().put(`/api/v1/users/${userId}/permission-overrides`).set(auth).send({ overrides: list });
const auditRows = (action: string) => prismaAdmin.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

describe('permission catalogue', () => {
  it('every key is <module>.<resource>.<action> (or fields.*), labelled in three languages; templates never hold owner-only keys', async () => {
    for (const p of PERMISSION_CATALOG) {
      expect(p.key).toMatch(p.field ? /^fields\.[a-z]+$/ : /^[a-z]+(\.[a-z]+)?\.(view|create|edit|approve|manage)$/);
      expect(p.label.en && p.label.roman && p.label.urdu).toBeTruthy();
    }
    for (const t of ROLE_TEMPLATES) for (const g of t.grants) expect(OWNER_ONLY_KEYS.has(g.key)).toBe(false);
    const res = await api().get('/api/v1/permissions/catalog').set(await munshi(seeded().malik.id));
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toHaveLength(PERMISSION_CATALOG.length);
    expect(res.body.data.permissions.find((p: { key: string }) => p.key === 'subscription.manage')).toMatchObject({ ownerOnly: true });
    expect(res.body.data.templates.map((t: { key: string }) => t.key)).toEqual(['ADMINISTRATOR', 'PROJECT_MANAGER', 'MUNSHI', 'ACCOUNTANT', 'STORE_KEEPER']);
    expect(res.body.data.financialBundle).toEqual(FINANCIAL_BUNDLE);
    // Administrator = every key except the owner-only ones, all projects, no limits.
    const admin = ROLE_TEMPLATES.find((t) => t.key === 'ADMINISTRATOR')!;
    expect(admin).toMatchObject({ baseRole: 'PM', name: { en: 'Administrator', roman: 'Admin', urdu: 'ایڈمن' } });
    expect(admin.grants.map((g) => g.key).sort()).toEqual(PERMISSION_CATALOG.filter((p) => !p.ownerOnly).map((p) => p.key).sort());
    for (const g of admin.grants) {
      expect(g.scope ?? null).toBe(PERMISSION_CATALOG.find((p) => p.key === g.key)!.scoped ? 'ALL_PROJECTS' : null);
      expect(g.maxAmountPaisa ?? null).toBeNull();
    }
  });

  it('resolution: owner = everything; role + ALLOW − DENY; owner-only keys are never granted', () => {
    const a = resolveAccess({
      role: 'PM',
      roleGrants: [{ permissionKey: 'projects.project.view' }, { permissionKey: 'labor.advance.create' }, { permissionKey: 'subscription.manage' }],
      overrides: [
        { permissionKey: 'labor.advance.create', effect: 'DENY' },
        { permissionKey: 'cashbook.expense.approve', effect: 'ALLOW', scope: 'ALL_PROJECTS', maxAmountPaisa: 5_000_000n },
        { permissionKey: 'company.settings.manage', effect: 'ALLOW' },
      ],
    });
    expect(a.permissions).toEqual(['cashbook.expense.approve', 'projects.project.view']);
    expect(a.denied).toEqual(['labor.advance.create']);
    expect(a.scopes['cashbook.expense.approve']).toBe('ALL_PROJECTS');
    expect(a.approvalLimits['cashbook.expense.approve']).toBe('5000000');
    expect(a.sources).toEqual({ 'cashbook.expense.approve': 'override', 'projects.project.view': 'role' });
    expect(defaultAccess('THEKEDAR').permissions).toHaveLength(PERMISSION_CATALOG.length);
    expect(() => assertApprovalLimit('cashbook.expense.approve', 6_000_000n, { userId: 'x', role: 'PM' })).not.toThrow(); // default PM: no limit
  });
});

describe('/auth/me and refresh', () => {
  it('returns permissions, fieldAccess, scopes, approvalLimits and the role; refresh recomputes', async () => {
    const t = seeded().malik.id;
    const o = await api().get('/api/v1/auth/me').set(await owner());
    expect(o.body.data.permissions).toHaveLength(PERMISSION_CATALOG.length);
    expect(o.body.data).toMatchObject({ fieldAccess: { rates: true, amounts: true, profit: true, contract: true }, permissionRole: null });
    expect(o.body.data.legacyPermissions).toContain('billing.view');

    const p = await api().get('/api/v1/auth/me').set(await pm());
    expect(p.body.data.permissionRole).toMatchObject({ key: 'PROJECT_MANAGER', name: 'Project Manager' });
    expect(p.body.data.fieldAccess).toEqual({ rates: true, amounts: false, profit: false, contract: false });
    expect(p.body.data.scopes['projects.project.view']).toBe('ASSIGNED_PROJECTS');
    expect(p.body.data.approvalLimits).toMatchObject({ 'cashbook.expense.approve': null, 'labor.settlement.approve': null });
    expect(p.body.data.legacyPermissions).toEqual(['rates.view', 'projects.manage', 'site.entry']);

    const m = await api().get('/api/v1/auth/me').set(await munshi(t));
    expect(m.body.data.permissionRole).toMatchObject({ key: 'MUNSHI' });
    expect(m.body.data.permissions).toContain('labor.attendance.create');
    expect(m.body.data.permissions).not.toContain('fields.rates');
  });
});

describe('roles', () => {
  it('system templates are read-only; duplicate → edit the copy; owner-only keys refused; every change audited', async () => {
    const o = await owner();
    const list = await api().get('/api/v1/roles').set(o);
    expect(list.body.data.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['ADMINISTRATOR', 'PROJECT_MANAGER', 'MUNSHI', 'ACCOUNTANT', 'STORE_KEEPER']));
    const pmRole = list.body.data.find((r: { key: string }) => r.key === 'PROJECT_MANAGER');
    expect(pmRole).toMatchObject({ isSystem: true, baseRole: 'PM', userCount: 1 });

    const sys = await api().put(`/api/v1/roles/${pmRole.id}/permissions`).set(o).send({ permissions: [] });
    expect(sys.status).toBe(403);
    expect(sys.body.error.code).toBe('ROLE_IS_SYSTEM');
    expect((await api().patch(`/api/v1/roles/${pmRole.id}`).set(o).send({ name: 'Senior Manager' })).body.error.code).toBe('ROLE_IS_SYSTEM');

    const copy = await api().post(`/api/v1/roles/${pmRole.id}/duplicate`).set(o).send({});
    expect(copy.status).toBe(201);
    expect(copy.body.data).toMatchObject({ name: 'Project Manager (copy)', isSystem: false, baseRole: 'PM' });
    expect(copy.body.data.permissions).toHaveLength(pmRole.permissions.length);

    const ownerOnly = await api().put(`/api/v1/roles/${copy.body.data.id}/permissions`).set(o).send({ permissions: [{ key: 'subscription.manage' }] });
    expect(ownerOnly.body.error).toMatchObject({ code: 'OWNER_ONLY_PERMISSION', details: { permission: 'subscription.manage' } });
    expect((await api().put(`/api/v1/roles/${copy.body.data.id}/permissions`).set(o).send({ permissions: [{ key: 'nope.nope.view' }] })).body.error.code).toBe('UNKNOWN_PERMISSION');
    expect((await api().put(`/api/v1/roles/${copy.body.data.id}/permissions`).set(o).send({ permissions: [{ key: 'fields.rates', scope: 'ALL_PROJECTS' }] })).body.error.code).toBe('SCOPE_NOT_SUPPORTED');
    expect((await api().put(`/api/v1/roles/${copy.body.data.id}/permissions`).set(o).send({ permissions: [{ key: 'projects.project.view', maxAmountPaisa: '100' }] })).body.error.code).toBe('LIMIT_NOT_SUPPORTED');

    const set = await api()
      .put(`/api/v1/roles/${copy.body.data.id}/permissions`)
      .set(o)
      .send({ permissions: [{ key: 'projects.project.view', scope: 'ALL_PROJECTS' }, { key: 'cashbook.expense.approve', maxAmountPaisa: rs(500) }] });
    expect(set.status).toBe(200);
    expect(set.body.data.permissions).toEqual([
      { key: 'cashbook.expense.approve', scope: 'ASSIGNED_PROJECTS', maxAmountPaisa: rs(500) },
      { key: 'projects.project.view', scope: 'ALL_PROJECTS', maxAmountPaisa: null },
    ]);
    const [created] = await auditRows('role.create');
    expect(created).toMatchObject({ entityId: copy.body.data.id, actorId: seeded().users.khalid.id });
    const [updated] = await auditRows('role.permissions_update');
    expect((updated!.details as { before: unknown[]; after: unknown[] }).before).toHaveLength(pmRole.permissions.length);
    expect((updated!.details as { before: unknown[]; after: unknown[] }).after).toHaveLength(2);

    expect((await api().get('/api/v1/roles').set(await pm())).body.error.code).toBe('PERMISSION_DENIED');
  });

  it('PATCH /users/:id/role: the role must fit the account; changes apply on the next request', async () => {
    const o = await owner();
    const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string }>;
    const munshiRole = roles.find((r) => r.key === 'MUNSHI')!;
    const accountant = roles.find((r) => r.key === 'ACCOUNTANT')!;
    const bilal = seeded().users.bilal.id;
    expect((await api().patch(`/api/v1/users/${bilal}/role`).set(o).send({ roleId: munshiRole.id })).body.error.code).toBe('ROLE_NOT_FOR_ACCOUNT');
    const p = await pm();
    expect((await api().get('/api/v1/finance/receivables').set(p)).status).toBe(403);
    const res = await api().patch(`/api/v1/users/${bilal}/role`).set(o).send({ roleId: accountant.id });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toMatchObject({ key: 'ACCOUNTANT' });
    // same token, next request: accountant may see P&L of all projects but no longer edits projects
    expect((await api().get('/api/v1/finance/pnl').set(p)).status).toBe(200);
    expect((await api().post('/api/v1/projects').set(p).send({})).body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'projects.project.create' } });
    expect((await api().patch(`/api/v1/users/${seeded().users.khalid.id}/role`).set(o).send({ roleId: accountant.id })).body.error.code).toBe('CANNOT_EDIT_OWNER');
    expect(await auditRows('user.role_change')).toHaveLength(1);
  });
});

describe('overrides', () => {
  it('ALLOW adds, DENY removes (403 PERMISSION_DENIED with the key); owners and owner-only keys are protected; audited', async () => {
    const o = await owner();
    const t = seeded().malik.id;
    const m = await munshi(t);
    const rafaqat = seeded().users.rafaqatMalik.id;
    const dha = seeded().projects.dha.id;
    const today = new Date().toISOString().slice(0, 10);

    expect((await api().get(`/api/v1/projects/${dha}/attendance/today`).set(m)).status).toBe(200);
    const deny = await overrides(o, rafaqat, [{ key: 'labor.attendance.view', effect: 'DENY', note: 'office only' }]);
    expect(deny.status).toBe(200);
    expect(deny.body.data.denied).toEqual(['labor.attendance.view']);
    const blocked = await api().get(`/api/v1/projects/${dha}/attendance/today`).set(m);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'labor.attendance.view' } });

    const p = await pm();
    const bilal = seeded().users.bilal.id;
    expect((await api().get('/api/v1/finance/pnl').set(p)).status).toBe(403);
    const allow = await overrides(o, bilal, [{ key: 'finance.pnl.view', effect: 'ALLOW' }, { key: 'fields.profit', effect: 'ALLOW' }]);
    expect(allow.body.data.effective).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'finance.pnl.view', source: 'override' })]));
    expect((await api().get('/api/v1/finance/pnl').set(p)).status).toBe(200);

    expect((await overrides(o, bilal, [{ key: 'company.settings.manage', effect: 'ALLOW' }])).body.error.code).toBe('OWNER_ONLY_PERMISSION');
    expect((await overrides(o, seeded().users.khalid.id, [])).body.error.code).toBe('CANNOT_EDIT_OWNER');
    expect((await overrides(p, rafaqat, [])).body.error.code).toBe('PERMISSION_DENIED');

    const rows = await auditRows('user.permissions_update');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.details).toMatchObject({ before: [], after: [{ key: 'labor.attendance.view', effect: 'DENY', note: 'office only' }] });

    const detail = await api().get(`/api/v1/users/${bilal}/permissions`).set(o);
    expect(detail.body.data).toMatchObject({ owner: false, role: { key: 'PROJECT_MANAGER' }, overrides: [expect.objectContaining({ key: 'fields.profit' }), expect.objectContaining({ key: 'finance.pnl.view' })] });
  });

  it('canSeeFinancials (deprecated) = the financial bundle as overrides', async () => {
    const o = await owner();
    const bilal = seeded().users.bilal.id;
    const res = await api().patch(`/api/v1/users/${bilal}`).set(o).send({ canSeeFinancials: true });
    expect(res.body.data.canSeeFinancials).toBe(true);
    const perms = await api().get(`/api/v1/users/${bilal}/permissions`).set(o);
    expect(perms.body.data.overrides.map((x: { key: string }) => x.key).sort()).toEqual([...FINANCIAL_BUNDLE].sort());
    expect(perms.body.data.fieldAccess).toEqual({ rates: true, amounts: true, profit: true, contract: true });
    await api().patch(`/api/v1/users/${bilal}`).set(o).send({ canSeeFinancials: false });
    expect((await api().get(`/api/v1/users/${bilal}/permissions`).set(o)).body.data.overrides).toEqual([]);
  });

  it('a non-owner manager (team.member.manage) can only grant what they hold and never touches owners or themselves', async () => {
    const o = await owner();
    const bilal = seeded().users.bilal.id;
    await overrides(o, bilal, [{ key: 'team.member.manage', effect: 'ALLOW' }]);
    const p = await pm();
    const rafaqat = seeded().users.rafaqatMalik.id;
    expect((await overrides(p, rafaqat, [{ key: 'fields.amounts', effect: 'ALLOW' }])).body.error).toMatchObject({ code: 'GRANT_EXCEEDS_OWN', details: { permission: 'fields.amounts' } });
    expect((await overrides(p, rafaqat, [{ key: 'labor.settlement.approve', effect: 'ALLOW', scope: 'ALL_PROJECTS' }])).body.error.code).toBe('GRANT_EXCEEDS_OWN');
    expect((await overrides(p, rafaqat, [{ key: 'fields.rates', effect: 'ALLOW' }])).status).toBe(200);
    expect((await overrides(p, bilal, [])).body.error.code).toBe('CANNOT_EDIT_OWN_PERMISSIONS');
    expect((await api().patch(`/api/v1/users/${seeded().users.khalid.id}`).set(p).send({ name: 'Someone' })).body.error.code).toBe('CANNOT_EDIT_OWNER');
  });
});

describe('several roles per member', () => {
  it('union: widest scope, highest limit ("no limit" wins), roles listed per key', () => {
    const access = resolveAccess({
      role: 'PM',
      roles: [
        { id: 'a', key: 'A', name: 'A' },
        { id: 'b', key: 'B', name: 'B' },
      ],
      roleGrants: [
        { permissionKey: 'projects.project.view', scope: 'ASSIGNED_PROJECTS', roleId: 'a' },
        { permissionKey: 'projects.project.view', scope: 'ALL_PROJECTS', roleId: 'b' },
        { permissionKey: 'cashbook.expense.approve', maxAmountPaisa: 100n, roleId: 'a' },
        { permissionKey: 'cashbook.expense.approve', maxAmountPaisa: 500n, roleId: 'b' },
        { permissionKey: 'labor.settlement.approve', maxAmountPaisa: 100n, roleId: 'a' },
        { permissionKey: 'labor.settlement.approve', maxAmountPaisa: null, roleId: 'b' },
        { permissionKey: 'fields.rates', roleId: 'a' },
      ],
      overrides: [{ permissionKey: 'fields.rates', effect: 'DENY' }],
    });
    expect(access.role).toEqual({ id: 'a', key: 'A', name: 'A' });
    expect(access.roles).toHaveLength(2);
    expect(access.scopes['projects.project.view']).toBe('ALL_PROJECTS');
    expect(access.approvalLimits['cashbook.expense.approve']).toBe('500');
    expect(access.approvalLimits['labor.settlement.approve']).toBeNull();
    expect(access.grantedBy['projects.project.view']).toEqual(['a', 'b']);
    expect(access.denied).toEqual(['fields.rates']);
  });

  it('PUT /users/:id/roles: union applies on the next request, sources list the roles, audited; account type enforced', async () => {
    const o = await owner();
    const bilal = seeded().users.bilal.id;
    const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string; userCount: number }>;
    expect(roles.map((r) => r.key).slice(0, 5)).toEqual(['ADMINISTRATOR', 'PROJECT_MANAGER', 'MUNSHI', 'ACCOUNTANT', 'STORE_KEEPER']);
    const pmRole = roles.find((r) => r.key === 'PROJECT_MANAGER')!;
    const accountant = roles.find((r) => r.key === 'ACCOUNTANT')!;
    const munshiRole = roles.find((r) => r.key === 'MUNSHI')!;
    const p = await pm();
    expect((await api().get('/api/v1/finance/pnl').set(p)).status).toBe(403);

    const res = await api().put(`/api/v1/users/${bilal}/roles`).set(o).send({ roleIds: [pmRole.id, accountant.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toMatchObject({ key: 'PROJECT_MANAGER' });
    expect(res.body.data.roles.map((r: { key: string }) => r.key)).toEqual(['PROJECT_MANAGER', 'ACCOUNTANT']);
    const view = res.body.data.effective.find((e: { key: string }) => e.key === 'projects.project.view');
    expect(view).toMatchObject({ source: 'role', scope: 'ALL_PROJECTS' });
    expect(view.roles.map((r: { key: string }) => r.key)).toEqual(['PROJECT_MANAGER', 'ACCOUNTANT']);
    expect(res.body.data.effective.find((e: { key: string }) => e.key === 'finance.pnl.view').roles).toEqual([expect.objectContaining({ key: 'ACCOUNTANT' })]);

    // Same token, next request: the union is in force (cache stamp).
    expect((await api().get('/api/v1/finance/pnl').set(p)).status).toBe(200);
    const me = await api().get('/api/v1/auth/me').set(p);
    expect(me.body.data.permissionRole).toMatchObject({ key: 'PROJECT_MANAGER' });
    expect(me.body.data.permissionRoles.map((r: { key: string }) => r.key)).toEqual(['PROJECT_MANAGER', 'ACCOUNTANT']);
    const list = (await api().get('/api/v1/users').set(o).query({ search: 'Bilal' })).body.data[0];
    expect(list.permissionRoles.map((r: { key: string }) => r.key)).toEqual(['PROJECT_MANAGER', 'ACCOUNTANT']);
    expect((await api().get('/api/v1/roles').set(o)).body.data.find((r: { key: string }) => r.key === 'ACCOUNTANT').userCount).toBe(accountant.userCount + 1);
    const audit = (await auditRows('user.role_change')).at(-1)!;
    expect(audit.details).toMatchObject({ before: [{ name: 'Project Manager' }], after: [{ name: 'Project Manager' }, { name: 'Accountant' }] });

    expect((await api().put(`/api/v1/users/${bilal}/roles`).set(o).send({ roleIds: [pmRole.id, munshiRole.id] })).body.error.code).toBe('ROLE_NOT_FOR_ACCOUNT');
    expect((await api().put(`/api/v1/users/${bilal}/roles`).set(o).send({ roleIds: [pmRole.id, pmRole.id] })).body.error.code).toBe('DUPLICATE_ROLE');
    expect((await api().put(`/api/v1/users/${bilal}/roles`).set(o).send({ roleIds: [] })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await api().put(`/api/v1/users/${seeded().users.khalid.id}/roles`).set(o).send({ roleIds: [pmRole.id] })).body.error.code).toBe('CANNOT_EDIT_OWNER');

    // PATCH /users/:id/role = one role again.
    const single = await api().patch(`/api/v1/users/${bilal}/role`).set(o).send({ roleId: pmRole.id });
    expect(single.body.data.roles.map((r: { key: string }) => r.key)).toEqual(['PROJECT_MANAGER']);
    expect((await api().get('/api/v1/finance/pnl').set(p)).status).toBe(403);
  });

  it('an invite can carry several roles (roleIds); accepting assigns them all', async () => {
    const o = await owner();
    const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string }>;
    const pmRole = roles.find((r) => r.key === 'PROJECT_MANAGER')!;
    const accountant = roles.find((r) => r.key === 'ACCOUNTANT')!;
    const munshiRole = roles.find((r) => r.key === 'MUNSHI')!;
    expect((await api().post('/api/v1/invitations').set(o).send({ name: 'Mixed Roles', phone: '+923451110002', role: 'PM', roleIds: [pmRole.id, munshiRole.id] })).body.error.code).toBe('ROLE_NOT_FOR_ACCOUNT');
    const inv = await api().post('/api/v1/invitations').set(o).send({ name: 'Two Roles', phone: '+923451110002', role: 'PM', roleIds: [pmRole.id, accountant.id], permissionOverrides: [{ key: 'fields.profit', effect: 'ALLOW' }] });
    expect(inv.status).toBe(201);
    const listed = (await api().get('/api/v1/invitations').set(o)).body.data.find((i: { id: string }) => i.id === inv.body.data.id);
    expect(listed).toMatchObject({ roleId: pmRole.id, roleIds: [pmRole.id, accountant.id] });
    const token = new URL(inv.body.data.inviteUrl).pathname.split('/').pop()!;
    const accepted = await api().post(`/api/v1/invitations/${token}/accept`).send({ client: 'mobile', password: 'Roles#2026', device: { deviceId: 'dev-roles', platform: 'ANDROID' } });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.permissionRoles.map((r: { key: string }) => r.key)).toEqual(['PROJECT_MANAGER', 'ACCOUNTANT']);
    expect(accepted.body.data.permissions).toEqual(expect.arrayContaining(['finance.pnl.view', 'projects.project.create', 'fields.profit']));
    expect(accepted.body.data.scopes['projects.project.view']).toBe('ALL_PROJECTS');
  });
});

describe('scope and approval limits', () => {
  it('ALL_PROJECTS scope opens every project; ASSIGNED keeps the old 404', async () => {
    const o = await owner();
    const bahria = seeded().projects.bahria.id; // Asif's project, not Bilal's
    const p = await pm();
    expect((await api().get(`/api/v1/projects/${bahria}`).set(p)).status).toBe(404);
    const total = (await api().get('/api/v1/projects').set(o)).body.meta.total;
    expect((await api().get('/api/v1/projects').set(p)).body.meta.total).toBeLessThan(total);
    await overrides(o, seeded().users.bilal.id, [{ key: 'projects.project.view', effect: 'ALLOW', scope: 'ALL_PROJECTS' }]);
    expect((await api().get(`/api/v1/projects/${bahria}`).set(p)).status).toBe(200);
    expect((await api().get('/api/v1/projects').set(p)).body.meta.total).toBe(total);
  });

  it('kharcha approve above the limit → 403 APPROVAL_LIMIT_EXCEEDED; within → approved', async () => {
    const t = seeded().malik.id;
    const o = await owner();
    const m = await munshi(t);
    await float(o, seeded().users.rafaqatMalik.id, rs(100000), m);
    const dha = seeded().projects.dha.id;
    const big = await api().post('/api/v1/cash-expenses').set(m).send({ projectId: dha, category: 'OTHER', amountPaisa: rs(40000), description: 'Sand trolley', clientId: uuidv7() });
    const small = await api().post('/api/v1/cash-expenses').set(m).send({ projectId: dha, category: 'OTHER', amountPaisa: rs(30000), description: 'Bajri', clientId: uuidv7() });
    expect(big.body.data.status).toBe('PENDING_APPROVAL');
    expect(small.body.data.status).toBe('PENDING_APPROVAL');

    await overrides(o, seeded().users.bilal.id, [{ key: 'cashbook.expense.approve', effect: 'ALLOW', maxAmountPaisa: rs(35000) }]);
    const p = await pm();
    const me = await api().get('/api/v1/auth/me').set(p);
    expect(me.body.data.approvalLimits['cashbook.expense.approve']).toBe(rs(35000));
    const over = await api().post(`/api/v1/cash-expenses/${big.body.data.id}/approve`).set(p).send({});
    expect(over.status).toBe(403);
    expect(over.body.error).toMatchObject({ code: 'APPROVAL_LIMIT_EXCEEDED', details: { permission: 'cashbook.expense.approve', maxAmountPaisa: rs(35000), amountPaisa: rs(40000) } });
    expect((await api().post(`/api/v1/cash-expenses/${small.body.data.id}/approve`).set(p).send({})).body.data.status).toBe('APPROVED');
    expect((await api().post(`/api/v1/cash-expenses/${big.body.data.id}/approve`).set(o).send({})).body.data.status).toBe('APPROVED');
  });

  it('supplier payment amount above the limit is refused by the route guard (amountFrom)', async () => {
    const o = await owner();
    await overrides(o, seeded().users.bilal.id, [{ key: 'procurement.payment.create', effect: 'ALLOW', maxAmountPaisa: rs(1000) }]);
    const p = await pm();
    const res = await api().post('/api/v1/supplier-payments').set(p).send({ amountPaisa: rs(5000) });
    expect(res.body.error.code).toBe('APPROVAL_LIMIT_EXCEEDED');
    expect((await api().post('/api/v1/supplier-payments').set(p).send({ amountPaisa: rs(500) })).body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('field stripping (REST and sync) and sync rules', () => {
  it('fields.rates decides supplier balances on REST and sub-contract rates on the phone', async () => {
    const t = seeded().malik.id;
    const o = await owner();
    const p = await pm();
    const withRates = (await api().get('/api/v1/suppliers').set(p)).body.data[0];
    expect(withRates).toHaveProperty('udhaarBalancePaisa');
    await overrides(o, seeded().users.bilal.id, [{ key: 'fields.rates', effect: 'DENY' }]);
    const without = (await api().get('/api/v1/suppliers').set(p)).body.data[0];
    expect(without).not.toHaveProperty('udhaarBalancePaisa');
    expect((await api().get(`/api/v1/suppliers/${without.id}/rates`).set(p)).body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'fields.rates' } });

    // phone: the munshi's pull carries the access block; a denied table is not pulled
    const m = await munshi(t);
    const pull = await api().get('/api/v1/sync/pull').set(m);
    expect(pull.body.data.access).toMatchObject({ fieldAccess: { rates: false }, permissionRole: { key: 'MUNSHI' } });
    expect(pull.body.data.changes.projects.upserts.length).toBeGreaterThan(0);
    await overrides(o, seeded().users.rafaqatMalik.id, [{ key: 'projects.project.view', effect: 'DENY' }, { key: 'labor.attendance.create', effect: 'DENY' }]);
    const again = await api().get('/api/v1/sync/pull').set(m);
    expect(again.body.data.changes.projects.upserts).toEqual([]);
    // incremental pull after a permission change → resync
    const inc = await api().get('/api/v1/sync/pull').set(m).query({ cursor: pull.body.data.cursor });
    expect(inc.body.data.resetRequired).toBe(true);

    const push = await api()
      .post('/api/v1/sync/push')
      .set(m)
      .send({ mutations: [{ clientId: uuidv7(), type: 'ATTENDANCE_UPSERT', payload: { projectId: seeded().projects.dha.id, date: new Date().toISOString().slice(0, 10), entries: [] } }] });
    expect(push.body.data.results[0]).toMatchObject({ status: 'REJECTED', error: { code: 'PERMISSION_DENIED', details: { permission: 'labor.attendance.create' } } });
  });
});

describe('provisioning and invitations', () => {
  it('backfill is idempotent and moves canSeeFinancials PMs to overrides', async () => {
    const t = seeded().malik.id;
    const bilal = seeded().users.bilal.id;
    await prismaAdmin.user.update({ where: { id: bilal }, data: { roleId: null, canSeeFinancials: true } });
    await prismaAdmin.userPermissionOverride.deleteMany({ where: { userId: bilal } });
    // A company provisioned before the Administrator template existed gets it on the next run.
    await prismaAdmin.role.delete({ where: { tenantId_key: { tenantId: t, key: 'ADMINISTRATOR' } } });
    const first = await prismaAdmin.$transaction((tx) => provisionPermissions(tx, t));
    expect(first).toMatchObject({ rolesCreated: 1, usersAssigned: 1, financialUsersMigrated: 1 });
    expect(await prismaAdmin.rolePermission.count({ where: { tenantId: t, role: { key: 'ADMINISTRATOR' } } })).toBe(PERMISSION_CATALOG.length - OWNER_ONLY_KEYS.size);
    const second = await prismaAdmin.$transaction((tx) => provisionPermissions(tx, t));
    expect(second).toEqual({ rolesCreated: 0, rolesUpdated: 0, usersAssigned: 0, financialUsersMigrated: 0 });
    expect(await prismaAdmin.userPermissionOverride.count({ where: { userId: bilal, effect: 'ALLOW' } })).toBe(FINANCIAL_BUNDLE.length);
    expect((await api().get('/api/v1/finance/pnl').set(await pm())).status).toBe(200);
  });

  it('an invite can carry a role; accepting assigns it (default: the template of the invited role)', async () => {
    const o = await owner();
    const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string }>;
    const keeper = roles.find((r) => r.key === 'STORE_KEEPER')!;
    const pmRole = roles.find((r) => r.key === 'PROJECT_MANAGER')!;
    expect((await api().post('/api/v1/invitations').set(o).send({ name: 'Wrong Fit', phone: '+923451110009', role: 'MUNSHI', roleId: pmRole.id })).body.error.code).toBe('ROLE_NOT_FOR_ACCOUNT');
    const inv = await api().post('/api/v1/invitations').set(o).send({ name: 'Naveed Store', phone: '+923451110008', role: 'MUNSHI', roleId: keeper.id });
    expect(inv.status).toBe(201);
    const token = new URL(inv.body.data.inviteUrl).pathname.split('/').pop()!;
    const accepted = await api().post(`/api/v1/invitations/${token}/accept`).send({ client: 'mobile', device: { deviceId: 'dev-keeper', platform: 'ANDROID' } });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.permissionRole).toMatchObject({ key: 'STORE_KEEPER' });
    expect(accepted.body.data.permissions).toContain('procurement.dispatch.create');
  });

  const tokenOf = (inv: { body: { data: { inviteUrl: string } } }) => new URL(inv.body.data.inviteUrl).pathname.split('/').pop()!;

  it('an invite carries permission overrides: listed, applied on accept (ALLOW + DENY), audited', async () => {
    const o = await owner();
    const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string }>;
    const pmRole = roles.find((r) => r.key === 'PROJECT_MANAGER')!;
    const permissionOverrides = [
      { key: 'billing.invoice.view', effect: 'ALLOW' },
      { key: 'cashbook.expense.approve', effect: 'ALLOW', scope: 'ALL_PROJECTS', maxAmountPaisa: rs(5000) },
      { key: 'clients.client.create', effect: 'DENY' },
    ];
    const inv = await api().post('/api/v1/invitations').set(o).send({ name: 'Usman Ghani', phone: '+923451110007', role: 'PM', roleId: pmRole.id, permissionOverrides });
    expect(inv.status).toBe(201);

    const list = await api().get('/api/v1/invitations').set(o);
    const listed = list.body.data.find((i: { id: string }) => i.id === inv.body.data.id);
    expect(listed).toMatchObject({ roleId: pmRole.id });
    expect(listed.permissionOverrides).toEqual([
      { key: 'billing.invoice.view', effect: 'ALLOW', scope: null, maxAmountPaisa: null, note: null },
      { key: 'cashbook.expense.approve', effect: 'ALLOW', scope: 'ALL_PROJECTS', maxAmountPaisa: rs(5000), note: null },
      { key: 'clients.client.create', effect: 'DENY', scope: null, maxAmountPaisa: null, note: null },
    ]);
    expect((await auditRows('invite.create'))[0]!.details).toMatchObject({ permissionOverrides: expect.arrayContaining([expect.objectContaining({ key: 'clients.client.create', effect: 'DENY' })]) });

    const accepted = await api().post(`/api/v1/invitations/${tokenOf(inv)}/accept`).send({ client: 'mobile', password: 'Usman#2026', device: { deviceId: 'dev-usman', platform: 'ANDROID' } });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.permissions).toContain('billing.invoice.view');
    expect(accepted.body.data.permissions).not.toContain('clients.client.create');
    expect(accepted.body.data.approvalLimits['cashbook.expense.approve']).toBe(rs(5000));

    const userId = accepted.body.data.user.id as string;
    const perms = (await api().get(`/api/v1/users/${userId}/permissions`).set(o)).body.data;
    expect(perms.role).toMatchObject({ key: 'PROJECT_MANAGER' });
    expect(perms.overrides).toEqual(permissionOverrides.map((p) => expect.objectContaining({ key: p.key, effect: p.effect })));
    expect(perms.denied).toEqual(['clients.client.create']);
    expect(perms.effective).toEqual(expect.arrayContaining([{ key: 'billing.invoice.view', source: 'override', roles: [], scope: 'ASSIGNED_PROJECTS', maxAmountPaisa: null }]));
    const rows = await prismaAdmin.userPermissionOverride.findMany({ where: { userId } });
    expect(rows.every((r) => r.createdById === seeded().users.khalid.id)).toBe(true);

    const audit = (await auditRows('user.permissions_update')).find((r) => r.entityId === userId)!;
    expect(audit).toMatchObject({ actorId: seeded().users.khalid.id, details: { via: 'invitation', invitationId: inv.body.data.id, before: [] } });
    expect((audit.details as { after: unknown[] }).after).toHaveLength(3);
    expect((await auditRows('invite.accept'))[0]!.details).toMatchObject({ permissionOverrides: 3 });
  });

  it('invite overrides are validated like PUT /users/:id/permission-overrides (owner-only, unknown, scope, duplicates)', async () => {
    const o = await owner();
    const send = (permissionOverrides: unknown[]) => api().post('/api/v1/invitations').set(o).send({ name: 'Wrong Perms', phone: '+923451110006', role: 'MUNSHI', permissionOverrides });
    expect((await send([{ key: 'subscription.manage', effect: 'ALLOW' }])).body.error).toMatchObject({ code: 'OWNER_ONLY_PERMISSION', details: { permission: 'subscription.manage' } });
    expect((await send([{ key: 'company.audit.view', effect: 'DENY' }])).body.error.code).toBe('OWNER_ONLY_PERMISSION');
    expect((await send([{ key: 'nope.nope.view', effect: 'ALLOW' }])).body.error.code).toBe('UNKNOWN_PERMISSION');
    expect((await send([{ key: 'fields.rates', effect: 'ALLOW', scope: 'ALL_PROJECTS' }])).body.error.code).toBe('SCOPE_NOT_SUPPORTED');
    expect((await send([{ key: 'labor.attendance.view', effect: 'DENY', scope: 'ALL_PROJECTS' }])).body.error.code).toBe('DENY_HAS_NO_SCOPE');
    expect((await send([{ key: 'fields.rates', effect: 'ALLOW' }, { key: 'fields.rates', effect: 'DENY' }])).body.error.code).toBe('DUPLICATE_PERMISSION');
    expect(await prismaAdmin.invitation.count({ where: { phone: '+923451110006' } })).toBe(0);
  });

  it('a non-owner inviter (team.member.manage) can only give what they hold — overrides and the Administrator role', async () => {
    const o = await owner();
    await overrides(o, seeded().users.bilal.id, [{ key: 'team.member.manage', effect: 'ALLOW' }]);
    const p = await pm();
    const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string }>;
    const admin = roles.find((r) => r.key === 'ADMINISTRATOR')!;
    const munshiRole = roles.find((r) => r.key === 'MUNSHI')!;
    const body = { name: 'Site Helper', phone: '+923451110005', role: 'MUNSHI', roleId: munshiRole.id };
    expect((await api().post('/api/v1/invitations').set(p).send({ ...body, permissionOverrides: [{ key: 'fields.amounts', effect: 'ALLOW' }] })).body.error).toMatchObject({ code: 'GRANT_EXCEEDS_OWN', details: { permission: 'fields.amounts' } });
    expect((await api().post('/api/v1/invitations').set(p).send({ ...body, permissionOverrides: [{ key: 'labor.attendance.view', effect: 'ALLOW', scope: 'ALL_PROJECTS' }] })).body.error.code).toBe('GRANT_EXCEEDS_OWN');
    expect((await api().post('/api/v1/invitations').set(p).send({ name: 'Office Admin', phone: '+923451110004', role: 'PM', roleId: admin.id })).body.error.code).toBe('GRANT_EXCEEDS_OWN');
    const ok = await api().post('/api/v1/invitations').set(p).send({ ...body, permissionOverrides: [{ key: 'fields.rates', effect: 'ALLOW' }, { key: 'labor.advance.create', effect: 'DENY' }] });
    expect(ok.status).toBe(201);
  });

  it('the Administrator template: every key except owner-only, all projects, no limits; office accounts only', async () => {
    const o = await owner();
    const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string; isSystem: boolean; baseRole: string; permissions: Array<{ key: string; scope: string | null; maxAmountPaisa: string | null }> }>;
    const admin = roles.find((r) => r.key === 'ADMINISTRATOR')!;
    expect(admin).toMatchObject({ isSystem: true, baseRole: 'PM' });
    expect(admin.permissions).toHaveLength(PERMISSION_CATALOG.length - OWNER_ONLY_KEYS.size);
    expect(admin.permissions.every((g) => g.maxAmountPaisa === null && (g.scope === null || g.scope === 'ALL_PROJECTS'))).toBe(true);
    expect((await api().post('/api/v1/invitations').set(o).send({ name: 'Wrong Fit', phone: '+923451110003', role: 'MUNSHI', roleId: admin.id })).body.error.code).toBe('ROLE_NOT_FOR_ACCOUNT');
    const inv = await api().post('/api/v1/invitations').set(o).send({ name: 'Office Admin', phone: '+923451110003', role: 'PM', roleId: admin.id });
    expect(inv.status).toBe(201);
    const accepted = await api().post(`/api/v1/invitations/${tokenOf(inv)}/accept`).send({ client: 'mobile', password: 'Admin#2026', device: { deviceId: 'dev-admin', platform: 'ANDROID' } });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.permissionRole).toMatchObject({ key: 'ADMINISTRATOR' });
    expect([...accepted.body.data.permissions].sort()).toEqual(PERMISSION_CATALOG.filter((x) => !x.ownerOnly).map((x) => x.key).sort());
    expect(accepted.body.data.user.canSeeFinancials).toBe(true);
  });
});
