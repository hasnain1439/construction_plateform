/**
 * Creates (or resets) a platform super admin — the account that signs in at /admin.
 *
 *   npm run admin:create -- --email owner@example.com --name "Owner" [--password "Secret#2026"]
 *
 * Without --password a strong random one is generated and printed once. Running it again for
 * the same email resets that admin's password, re-activates it and clears any lockout.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../src/config/env.js';
import { disconnectDatabases, prismaAdmin } from '../src/core/db/prisma.js';
import { passwordSchema } from '../src/modules/auth/auth.schema.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 16 chars with upper, lower, digit and symbol — passes passwordSchema. */
function generatePassword(): string {
  const body = randomBytes(12).toString('base64url').replace(/[-_]/g, 'x');
  return `${body}A9#`;
}

const input = z
  .object({
    email: z.email('Pass a valid --email').transform((v) => v.trim().toLowerCase()),
    name: z.string().trim().min(2, 'Pass --name (at least 2 characters)').max(80),
    password: passwordSchema,
  })
  .safeParse({ email: arg('email'), name: arg('name') ?? 'Super Admin', password: arg('password') ?? generatePassword() });

if (!input.success) {
  console.error(input.error.issues.map((i) => `✗ ${i.path.join('.')}: ${i.message}`).join('\n'));
  console.error('Usage: npm run admin:create -- --email you@example.com --name "Your Name" [--password "..."]');
  process.exit(1);
}

const { email, name, password } = input.data;
const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
const existing = await prismaAdmin.platformAdmin.findUnique({ where: { email }, select: { id: true } });
await prismaAdmin.platformAdmin.upsert({
  where: { email },
  create: { email, name, passwordHash },
  update: { name, passwordHash, isActive: true, failedLoginCount: 0, lockedUntil: null },
});
await disconnectDatabases();

console.log(`${existing ? 'Updated' : 'Created'} super admin`);
console.log(`  Email:    ${email}`);
console.log(`  Password: ${password}${arg('password') ? '' : '   (generated — save it now, it is not shown again)'}`);
console.log(`  Sign in:  /admin/login on the web app`);
