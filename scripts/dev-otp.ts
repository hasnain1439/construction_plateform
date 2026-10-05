/**
 * Development / E2E helper: issues a fresh LOGIN code for a phone and prints it, so a
 * browser test can sign a munshi in without reading the server console.
 *
 *   npm run dev:otp -- +923211234567     → prints "OTP=123456"
 *
 * Refuses to run in production. Earlier codes for the phone are moved back an hour first,
 * so the 60 s resend wait and the hourly limit don't block repeated test runs.
 */
import { env } from '../src/config/env.js';
import { disconnectDatabases, prismaAdmin } from '../src/core/db/prisma.js';
import { normalizePkPhone } from '../src/core/utils/phone.js';
import { issueOtp } from '../src/modules/auth/otp.service.js';

if (env.NODE_ENV === 'production') {
  console.error('dev-otp is for development only');
  process.exit(1);
}

const phone = normalizePkPhone(process.argv[2] ?? '');
if (!phone) {
  console.error('Usage: npm run dev:otp -- <phone>');
  process.exit(1);
}

await prismaAdmin.$executeRaw`
  UPDATE "OtpCode" SET "lastSentAt" = "lastSentAt" - interval '1 hour', "createdAt" = "createdAt" - interval '1 hour'
  WHERE phone = ${phone}`;
const { code } = await issueOtp(phone, 'LOGIN');
console.log(`OTP=${code}`);
await disconnectDatabases();
