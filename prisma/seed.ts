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
import type { Prisma, PrismaClient, UserRole } from '../src/generated/prisma/client.js';
import { MATERIAL_GROUPS, PLATFORM_MATERIALS } from '../src/modules/master-data/catalog.js';
import { provisionMasterData } from '../src/modules/master-data/provision.js';
import { seedMalikMasterData } from './seedMasterData.js';
import { seedMalikInventory } from './seedInventory.js';
import { seedMalikBilling } from './seedBilling.js';
import { seedMalikNotifications } from './seedNotifications.js';
import { seedMalikDailyLogs } from './seedDailyLogs.js';
import { seedMalikLabor } from './seedLabor.js';
import { ensureProjectRow, seedAhmedProject, seedMalikClients, seedMalikProjects } from './seedProjects.js';

export const SEED = {
  admin: { email: 'admin@platform.local', password: 'Admin#2026', name: 'Platform Admin' },
  malik: {
    slug: 'malik-and-sons-builders',
    name: 'Malik & Sons Builders',
    owner: { name: 'Khalid Malik', phone: '+923001234567', email: 'khalid@maliksons.pk', password: 'Thekedar#2026' },
    pm: { name: 'Bilal Ahmed', phone: '+923331112233', password: 'Bilal#2026' },
    munshi: { name: 'Rafaqat Ali', phone: '+923211234567' },
    munshi2: { name: 'Asif Mehmood', phone: '+923224567890' },
  },
  ahmed: {
    slug: 'ahmed-constructions',
    name: 'Ahmed Constructions',
    owner: { name: 'Ahmed Raza', phone: '+923331234567', password: 'Ahmed#2026' },
  },
  invitation: { name: 'Kamran Shah', phone: '+923009988776', token: 'dev-invite-kamran-shah-2026-0001' },
  /** Subscription in GRACE: period ended yesterday, 3 days to pay. */
  valley: { slug: 'valley-builders', name: 'Valley Builders', owner: { name: 'Zubair Khan', phone: '+923451000001', password: 'Valley#2026' } },
  /** Subscription LAPSED: company is READ_ONLY. */
  oldTown: { slug: 'old-town-contractors', name: 'Old Town Contractors', owner: { name: 'Nasir Butt', phone: '+923451000002', password: 'OldTown#2026' } },
} as const;

const PLANS = [
  { code: 'TRIAL', sortOrder: 0, name: 'Trial', priceMonthlyPaisa: 0n, maxActiveProjects: 2, maxOfficeUsers: 3, features: ['14 days free', '2 active projects', '3 office users', 'Unlimited munshis'] },
  { code: 'STARTER', sortOrder: 1, name: 'Starter', priceMonthlyPaisa: 400_000n, maxActiveProjects: 2, maxOfficeUsers: 3, features: ['2 active projects', '3 office users', 'Unlimited munshis', 'Mobile app for site staff'] },
  { code: 'PROFESSIONAL', sortOrder: 2, name: 'Professional', priceMonthlyPaisa: 950_000n, maxActiveProjects: 5, maxOfficeUsers: 10, features: ['5 active projects', '10 office users', 'Unlimited munshis', 'Profit & billing reports'] },
  { code: 'ENTERPRISE', sortOrder: 3, name: 'Enterprise', priceMonthlyPaisa: 2_000_000n, maxActiveProjects: null, maxOfficeUsers: null, features: ['Unlimited projects', 'Unlimited office users', 'Priority support'] },
] as const;

const DAY = 86_400_000;

/**
 * Fixed-date national holidays. Islamic holidays (Eid, Ashura, Eid Milad) move with the
 * moon and are announced each year — platform admins add those per year.
 */
const NATIONAL_HOLIDAYS = [
  ['02-05', 'Kashmir Solidarity Day'],
  ['03-23', 'Pakistan Day'],
  ['05-01', 'Labour Day'],
  ['08-14', 'Independence Day'],
  ['11-09', 'Iqbal Day'],
  ['12-25', 'Quaid-e-Azam Day'],
] as const;

interface SeedSubscription {
  status: 'TRIAL' | 'ACTIVE' | 'GRACE' | 'LAPSED';
  /** Days from now (negative = in the past) */
  periodEndsInDays: number;
}

async function upsertTenant(
  db: PrismaClient,
  data: { slug: string; name: string; region: 'PUNJAB_KP' | 'KARACHI_SINDH'; planId: string; subscription?: SeedSubscription },
) {
  const sub: SeedSubscription = data.subscription ?? { status: 'ACTIVE', periodEndsInDays: 30 };
  // Subscription status → company status: LAPSED companies are READ_ONLY.
  const tenantStatus = sub.status === 'LAPSED' ? 'READ_ONLY' : 'ACTIVE';
  const tenant = await db.tenant.upsert({
    where: { slug: data.slug },
    create: { slug: data.slug, name: data.name, region: data.region, status: tenantStatus },
    update: { name: data.name, region: data.region, status: tenantStatus },
  });
  await db.tenantSettings.upsert({
    where: { tenantId: tenant.id },
    create: { tenantId: tenant.id, marlaStandardSqft: 225 },
    update: {},
  });
  const periodEnd = new Date(Date.now() + sub.periodEndsInDays * DAY);
  const subscription = {
    planId: data.planId,
    status: sub.status,
    trialEndsAt: sub.status === 'TRIAL' ? periodEnd : null,
    currentPeriodStart: sub.status === 'TRIAL' ? null : new Date(periodEnd.getTime() - 30 * DAY),
    currentPeriodEnd: sub.status === 'TRIAL' ? null : periodEnd,
    graceEndsAt: sub.status === 'GRACE' || sub.status === 'LAPSED' ? new Date(periodEnd.getTime() + 3 * DAY) : null,
    pendingPlanId: null,
    pendingEffectiveOn: null,
    keepActiveProjectIds: [],
    lastReminderSentAt: null,
    cancelledAt: null,
  };
  await db.subscription.upsert({
    where: { tenantId: tenant.id },
    create: { tenantId: tenant.id, ...subscription },
    update: subscription,
  });
  return tenant;
}

/** Calendar date `days` ago at UTC midnight (how DATE columns are stored). */
function dateDaysAgo(days: number): Date {
  return new Date(`${new Date(Date.now() - days * DAY).toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function upsertPayment(
  db: PrismaClient,
  data: {
    tenantId: string;
    planId: string;
    amountPaisa: bigint;
    method: 'JAZZCASH' | 'EASYPAISA' | 'RAAST' | 'IBFT';
    transactionId: string;
    paidDaysAgo: number;
    status: 'PENDING_REVIEW' | 'APPROVED';
    /** Approved only: period covered, in days from now */
    period?: [number, number];
    receiptNo?: string;
  },
) {
  const subscription = await db.subscription.findUniqueOrThrow({ where: { tenantId: data.tenantId } });
  const fields = {
    tenantId: data.tenantId,
    subscriptionId: subscription.id,
    planId: data.planId,
    amountPaisa: data.amountPaisa,
    method: data.method,
    paidOn: dateDaysAgo(data.paidDaysAgo),
    status: data.status,
    periodStart: data.period ? new Date(Date.now() + data.period[0] * DAY) : null,
    periodEnd: data.period ? new Date(Date.now() + data.period[1] * DAY) : null,
    receiptNo: data.receiptNo ?? null,
    reviewedAt: data.status === 'APPROVED' ? new Date(Date.now() - (data.paidDaysAgo - 1) * DAY) : null,
  };
  return db.subscriptionPayment.upsert({
    where: { transactionId: data.transactionId },
    create: { transactionId: data.transactionId, ...fields },
    update: fields,
  });
}

/** Platform material catalog: groups + materials (upsert by code / name). */
async function seedCatalog(db: PrismaClient) {
  const groups: Record<string, string> = {};
  for (const g of MATERIAL_GROUPS) {
    groups[g.code] = (await db.materialGroup.upsert({ where: { code: g.code }, create: g, update: g })).id;
  }
  for (const [i, m] of PLATFORM_MATERIALS.entries()) {
    const data = {
      groupId: groups[m.group]!,
      unit: m.unit,
      unitDetail: m.unitDetail ?? null,
      altUnits: (m.altUnits ?? []) as unknown as Prisma.InputJsonValue,
      supplyCategory: m.supplyCategory,
      usedByRulebook: Boolean(m.rulebookKey),
      rulebookKey: m.rulebookKey ?? null,
      isActive: true,
      sortOrder: i + 1,
    };
    await db.platformMaterial.upsert({ where: { name: m.name }, create: { name: m.name, ...data }, update: data });
  }
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

/** `inventory` / `labor` / `billing: false` skip the Step 6 / 7 / 8 demos (the test suite seeds them only where needed). */
export async function seed(db: PrismaClient = prismaAdmin, opts: { inventory?: boolean; labor?: boolean; billing?: boolean } = {}) {
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
    const data = { ...plan, features: [...plan.features] };
    plans[plan.code] = await db.plan.upsert({ where: { code: plan.code }, create: data, update: data });
  }

  await seedCatalog(db);

  // Platform holidays for this year and next
  const year = new Date().getUTCFullYear();
  for (const y of [year, year + 1]) {
    for (const [monthDay, name] of NATIONAL_HOLIDAYS) {
      const startDate = new Date(`${y}-${monthDay}T00:00:00.000Z`);
      await db.platformHoliday.upsert({ where: { startDate_name: { startDate, name } }, create: { startDate, name }, update: {} });
    }
  }

  // Malik & Sons Builders (Professional)
  const malik = await upsertTenant(db, {
    slug: SEED.malik.slug,
    name: SEED.malik.name,
    region: 'PUNJAB_KP',
    planId: plans['PROFESSIONAL']!.id,
    subscription: { status: 'ACTIVE', periodEndsInDays: 12 },
  });
  const pro = { tenantId: malik.id, planId: plans['PROFESSIONAL']!.id, amountPaisa: 950_000n, status: 'APPROVED' as const };
  await upsertPayment(db, { ...pro, method: 'JAZZCASH', transactionId: 'JC2607180931', paidDaysAgo: 79, period: [-78, -48], receiptNo: 'RCPT-2026-0371' });
  await upsertPayment(db, { ...pro, method: 'RAAST', transactionId: 'RAAST2608171447', paidDaysAgo: 49, period: [-48, -18], receiptNo: 'RCPT-2026-0372' });
  await upsertPayment(db, { ...pro, method: 'IBFT', transactionId: 'IBFT2609160552', paidDaysAgo: 19, period: [-18, 12], receiptNo: 'RCPT-2026-0381' });
  await db.tenant.update({
    where: { id: malik.id },
    data: { ntn: '1234567-8', address: 'Office 12, MM Alam Road, Gulberg III, Lahore', phone: '+924235761234', email: 'info@maliksons.pk' },
  });
  // Project rows first (the invitation below points at DHA); details are filled in at the end
  const dha = await ensureProjectRow(db, malik.id, 'MSB-2026-012', 'DHA Phase 6 · 10 Marla', 'DHA Phase 6 — 1 Kanal Villa');
  const khalid = await upsertUser(db, { tenantId: malik.id, ...SEED.malik.owner, role: 'THEKEDAR' });
  const bilal = await upsertUser(db, { tenantId: malik.id, ...SEED.malik.pm, role: 'PM', canSeeFinancials: false });
  const rafaqatMalik = await upsertUser(db, { tenantId: malik.id, ...SEED.malik.munshi, role: 'MUNSHI' });
  const asif = await upsertUser(db, { tenantId: malik.id, ...SEED.malik.munshi2, role: 'MUNSHI' });

  // Ahmed Constructions (Starter) — second tenant for isolation tests
  const ahmed = await upsertTenant(db, {
    slug: SEED.ahmed.slug,
    name: SEED.ahmed.name,
    region: 'PUNJAB_KP',
    planId: plans['STARTER']!.id,
    subscription: { status: 'ACTIVE', periodEndsInDays: 20 },
  });
  await upsertPayment(db, {
    tenantId: ahmed.id,
    planId: plans['STARTER']!.id,
    amountPaisa: 400_000n,
    method: 'EASYPAISA',
    transactionId: 'EP2610010042',
    paidDaysAgo: 1,
    status: 'PENDING_REVIEW',
  });
  const ahmedOwner = await upsertUser(db, { tenantId: ahmed.id, ...SEED.ahmed.owner, role: 'THEKEDAR' });
  // Rafaqat also works for Ahmed → MULTIPLE_COMPANIES on his phone
  const rafaqatAhmed = await upsertUser(db, { tenantId: ahmed.id, ...SEED.malik.munshi, role: 'MUNSHI' });

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

  // Valley Builders: period ended yesterday → GRACE (3 days to pay)
  const valley = await upsertTenant(db, {
    slug: SEED.valley.slug,
    name: SEED.valley.name,
    region: 'KARACHI_SINDH',
    planId: plans['STARTER']!.id,
    subscription: { status: 'GRACE', periodEndsInDays: -1 },
  });
  await upsertUser(db, { tenantId: valley.id, ...SEED.valley.owner, role: 'THEKEDAR' });
  await ensureProjectRow(db, valley.id, 'VB-2026-001', 'Clifton — Apartment Renovation');

  // Old Town Contractors: grace ran out → LAPSED, company READ_ONLY
  const oldTown = await upsertTenant(db, {
    slug: SEED.oldTown.slug,
    name: SEED.oldTown.name,
    region: 'PUNJAB_KP',
    planId: plans['STARTER']!.id,
    subscription: { status: 'LAPSED', periodEndsInDays: -10 },
  });
  await upsertUser(db, { tenantId: oldTown.id, ...SEED.oldTown.owner, role: 'THEKEDAR' });

  // Every company gets the starting master data (catalog copy, categories, labour rates, template).
  for (const t of [malik, ahmed, valley, oldTown]) await provisionMasterData(db, t.id);
  await seedMalikMasterData(db, malik.id, khalid.id);
  const clients = await seedMalikClients(db, malik.id, khalid.id);
  const malikProjects = await seedMalikProjects(db, {
    tenantId: malik.id,
    ownerId: khalid.id,
    bilalId: bilal.id,
    rafaqatId: rafaqatMalik.id,
    asifId: asif.id,
    clients,
  });
  const ahmedProject = await seedAhmedProject(db, ahmed.id, ahmedOwner.id, rafaqatAhmed.id);
  if (opts.inventory !== false) {
    await seedMalikInventory(db, { tenantId: malik.id, ownerId: khalid.id, bilalId: bilal.id, rafaqatId: rafaqatMalik.id, projects: malikProjects });
  }
  if (opts.labor !== false) {
    await seedMalikLabor(db, { tenantId: malik.id, ownerId: khalid.id, bilalId: bilal.id, rafaqatId: rafaqatMalik.id, asifId: asif.id, projects: malikProjects });
    await seedMalikDailyLogs(db, { tenantId: malik.id, rafaqatId: rafaqatMalik.id, asifId: asif.id, projects: malikProjects });
  }
  if (opts.billing !== false) {
    const billing = await seedMalikBilling(db, { tenantId: malik.id, ownerId: khalid.id, projects: malikProjects });
    // Notifications point at stock, labour and billing records — only with the full demo, written now.
    if (!billing.skipped && opts.inventory !== false && opts.labor !== false) await seedMalikNotifications(db, { tenantId: malik.id, ownerId: khalid.id, bilalId: bilal.id, rafaqatId: rafaqatMalik.id, projects: malikProjects });
  }

  return {
    malik,
    ahmed,
    valley,
    oldTown,
    plans: plans as Record<'TRIAL' | 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE', { id: string }>,
    projects: { ...malikProjects, ahmedProject },
    users: { khalid, bilal, rafaqatMalik, rafaqatAhmed, asif },
    clients,
  };
}

async function main() {
  await seed();
  const invite = `${env.APP_URL}/invite/${SEED.invitation.token}`;
  console.log(`
Seed complete.

  Platform admin   ${SEED.admin.email} / ${SEED.admin.password}

  Malik & Sons Builders (Professional, ACTIVE — renews in 12 days, 3 approved payments)
    THEKEDAR  Khalid Malik  ${SEED.malik.owner.phone} / ${SEED.malik.owner.password}
    PM        Bilal Ahmed   ${SEED.malik.pm.phone} / ${SEED.malik.pm.password}   (no financials)
    MUNSHI    Rafaqat Ali   ${SEED.malik.munshi.phone}  (OTP only)
    Stock     store purchases + GP-0140…0144 (GP-0143 / GP-0144 on the way), 2 open shortages on GP-0142, CB-1190 waiting at Bahria

  Ahmed Constructions (Starter, ACTIVE — Easypaisa EP2610010042 pending review)
    THEKEDAR  Ahmed Raza    ${SEED.ahmed.owner.phone} / ${SEED.ahmed.owner.password}
    MUNSHI    Rafaqat Ali   ${SEED.malik.munshi.phone}  (OTP only → MULTIPLE_COMPANIES)

  Valley Builders (Starter, GRACE — period ended yesterday)
    THEKEDAR  Zubair Khan   ${SEED.valley.owner.phone} / ${SEED.valley.owner.password}

  Old Town Contractors (Starter, LAPSED — company READ_ONLY)
    THEKEDAR  Nasir Butt    ${SEED.oldTown.owner.phone} / ${SEED.oldTown.owner.password}

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
