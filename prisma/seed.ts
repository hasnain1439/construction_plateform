/**
 * Development / test seed. Idempotent: safe to run repeatedly (upserts by natural keys
 * and resets the demo passwords, locks and the demo invitation).
 *
 *   npm run db:seed
 */
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env.js';
import { prismaAdmin } from '../src/core/db/prisma.js';
import { hashSecret } from '../src/core/utils/crypto.js';
import type { PrismaClient, UserRole } from '../src/generated/prisma/client.js';

export const SEED = {
  admin: { email: 'admin@platform.local', password: 'Admin#2026', name: 'Platform Admin' },
  malik: {
    slug: 'malik-and-sons-builders',
    name: 'Malik & Sons Builders',
    owner: { name: 'Khalid Malik', phone: '+923001234567', email: 'khalid@maliksons.pk', password: 'Thekedar#2026' },
    pm: { name: 'Bilal Ahmed', phone: '+923331112233', password: 'Bilal#2026' },
    munshi: { name: 'Rafaqat Ali', phone: '+923211234567' },
  },
  ahmed: {
    slug: 'ahmed-constructions',
    name: 'Ahmed Constructions',
    owner: { name: 'Ahmed Raza', phone: '+923331234567', password: 'Ahmed#2026' },
  },
  invitation: { name: 'Kamran Shah', phone: '+923009988776', token: 'dev-invite-kamran-shah-2026-0001' },
} as const;

const PLANS = [
  { code: 'TRIAL', name: 'Trial', priceMonthlyPaisa: 0n, maxProjects: 2, maxOfficeUsers: 3 },
  { code: 'STARTER', name: 'Starter', priceMonthlyPaisa: 400_000n, maxProjects: 2, maxOfficeUsers: 3 },
  { code: 'PROFESSIONAL', name: 'Professional', priceMonthlyPaisa: 950_000n, maxProjects: 5, maxOfficeUsers: 10 },
  { code: 'ENTERPRISE', name: 'Enterprise', priceMonthlyPaisa: 2_000_000n, maxProjects: null, maxOfficeUsers: null },
] as const;

const DAY = 86_400_000;

async function upsertTenant(
  db: PrismaClient,
  data: { slug: string; name: string; region: 'PUNJAB_KP' | 'KARACHI_SINDH'; planId: string },
) {
  const tenant = await db.tenant.upsert({
    where: { slug: data.slug },
    create: { slug: data.slug, name: data.name, region: data.region, status: 'ACTIVE' },
    update: { name: data.name, region: data.region, status: 'ACTIVE' },
  });
  await db.tenantSettings.upsert({
    where: { tenantId: tenant.id },
    create: { tenantId: tenant.id, marlaStandardSqft: 225 },
    update: {},
  });
  const subscription = { planId: data.planId, status: 'ACTIVE' as const, trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 30 * DAY) };
  await db.subscription.upsert({
    where: { tenantId: tenant.id },
    create: { tenantId: tenant.id, ...subscription },
    update: subscription,
  });
  return tenant;
}

async function upsertUser(
  db: PrismaClient,
  data: {
    tenantId: string;
    name: string;
    phone: string;
    email?: string;
    password?: string;
    role: UserRole;
    canSeeFinancials?: boolean;
  },
) {
  const passwordHash = data.password ? await bcrypt.hash(data.password, env.BCRYPT_ROUNDS) : null;
  const fields = {
    name: data.name,
    email: data.email ?? null,
    passwordHash,
    passwordChangedAt: passwordHash ? new Date() : null,
    role: data.role,
    status: 'ACTIVE' as const,
    canSeeFinancials: data.canSeeFinancials ?? false,
    failedLoginCount: 0,
    lockedUntil: null,
  };
  return db.user.upsert({
    where: { tenantId_phone: { tenantId: data.tenantId, phone: data.phone } },
    create: { tenantId: data.tenantId, phone: data.phone, ...fields },
    update: fields,
  });
}

async function ensureProject(db: PrismaClient, tenantId: string, name: string) {
  const existing = await db.project.findFirst({ where: { tenantId, name } });
  return existing ?? db.project.create({ data: { tenantId, name } });
}

export async function seed(db: PrismaClient = prismaAdmin) {
  // Platform admin
  await db.platformAdmin.upsert({
    where: { email: SEED.admin.email },
    create: {
      email: SEED.admin.email,
      name: SEED.admin.name,
      passwordHash: await bcrypt.hash(SEED.admin.password, env.BCRYPT_ROUNDS),
    },
    update: {
      passwordHash: await bcrypt.hash(SEED.admin.password, env.BCRYPT_ROUNDS),
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  // Plans
  const plans: Record<string, { id: string }> = {};
  for (const plan of PLANS) {
    plans[plan.code] = await db.plan.upsert({ where: { code: plan.code }, create: plan, update: plan });
  }

  // Malik & Sons Builders (Professional)
  const malik = await upsertTenant(db, { slug: SEED.malik.slug, name: SEED.malik.name, region: 'PUNJAB_KP', planId: plans['PROFESSIONAL']!.id });
  const dha = await ensureProject(db, malik.id, 'DHA Phase 6 — 1 Kanal Villa');
  const bahria = await ensureProject(db, malik.id, 'Bahria Town — Commercial Plaza');
  const khalid = await upsertUser(db, { tenantId: malik.id, ...SEED.malik.owner, role: 'THEKEDAR' });
  const bilal = await upsertUser(db, { tenantId: malik.id, ...SEED.malik.pm, role: 'PM', canSeeFinancials: false });
  const rafaqatMalik = await upsertUser(db, { tenantId: malik.id, ...SEED.malik.munshi, role: 'MUNSHI' });
  await db.userProjectAccess.createMany({
    data: [
      { tenantId: malik.id, userId: bilal.id, projectId: dha.id },
      { tenantId: malik.id, userId: bilal.id, projectId: bahria.id },
      { tenantId: malik.id, userId: rafaqatMalik.id, projectId: dha.id },
    ],
    skipDuplicates: true,
  });

  // Ahmed Constructions (Starter) — second tenant for isolation tests
  const ahmed = await upsertTenant(db, { slug: SEED.ahmed.slug, name: SEED.ahmed.name, region: 'PUNJAB_KP', planId: plans['STARTER']!.id });
  const ahmedProject = await ensureProject(db, ahmed.id, 'Gulberg — 10 Marla House');
  await upsertUser(db, { tenantId: ahmed.id, ...SEED.ahmed.owner, role: 'THEKEDAR' });
  // Rafaqat also works for Ahmed → MULTIPLE_COMPANIES on his phone
  const rafaqatAhmed = await upsertUser(db, { tenantId: ahmed.id, ...SEED.malik.munshi, role: 'MUNSHI' });
  await db.userProjectAccess.createMany({
    data: [{ tenantId: ahmed.id, userId: rafaqatAhmed.id, projectId: ahmedProject.id }],
    skipDuplicates: true,
  });

  // Pending invitation for Kamran Shah (PM at Malik & Sons)
  const invitation = {
    tenantId: malik.id,
    role: 'PM' as const,
    name: SEED.invitation.name,
    phone: SEED.invitation.phone,
    canSeeFinancials: false,
    projectIds: [dha.id],
    status: 'PENDING' as const,
    expiresAt: new Date(Date.now() + 7 * DAY),
    invitedById: khalid.id,
    acceptedUserId: null,
    acceptedAt: null,
  };
  await db.invitation.upsert({
    where: { tokenHash: hashSecret(SEED.invitation.token) },
    create: { tokenHash: hashSecret(SEED.invitation.token), ...invitation },
    update: invitation,
  });

  return { malik, ahmed, projects: { dha, bahria, ahmedProject }, users: { khalid, bilal, rafaqatMalik, rafaqatAhmed } };
}

async function main() {
  await seed();
  const invite = `${env.APP_URL}/invite/${SEED.invitation.token}`;
  console.log(`
Seed complete.

  Platform admin   ${SEED.admin.email} / ${SEED.admin.password}

  Malik & Sons Builders (Professional)
    THEKEDAR  Khalid Malik  ${SEED.malik.owner.phone} / ${SEED.malik.owner.password}
    PM        Bilal Ahmed   ${SEED.malik.pm.phone} / ${SEED.malik.pm.password}   (no financials)
    MUNSHI    Rafaqat Ali   ${SEED.malik.munshi.phone}  (OTP only)

  Ahmed Constructions (Starter)
    THEKEDAR  Ahmed Raza    ${SEED.ahmed.owner.phone} / ${SEED.ahmed.owner.password}
    MUNSHI    Rafaqat Ali   ${SEED.malik.munshi.phone}  (OTP only → MULTIPLE_COMPANIES)

  Pending invitation (PM, Kamran Shah ${SEED.invitation.phone})
    token: ${SEED.invitation.token}
    link:  ${invite}
    API:   POST /api/v1/invitations/${SEED.invitation.token}/accept
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prismaAdmin.$disconnect());
}
