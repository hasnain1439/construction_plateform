import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { maskPhone } from '../../core/utils/phone.js';
import type { UserRole } from '../../generated/prisma/enums.js';
import { trySendMail } from './mail.provider.js';
import { smsProvider } from './sms.provider.js';

const ROLE_LABEL: Record<UserRole, string> = { THEKEDAR: 'Thekedar', PM: 'Project Manager', MUNSHI: 'Munshi' };

export function inviteUrl(token: string): string {
  return `${env.APP_URL.replace(/\/+$/, '')}/invite/${token}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface InviteDelivery {
  phone: string;
  email?: string | null;
  name: string;
  companyName: string;
  role: UserRole;
  token: string;
  /** A brand-new company created from the platform console (owner invite). */
  newCompany?: boolean;
}

/**
 * Sends the one-time invite link by SMS and — when the invite has an email — by email too.
 * Best effort: the invitation stays valid if delivery fails (it can be resent). The token is
 * never logged.
 */
export async function deliverInvite(d: InviteDelivery): Promise<void> {
  const url = inviteUrl(d.token);
  const role = ROLE_LABEL[d.role];
  const sms = d.newCompany
    ? `${d.companyName} ka account tayyar hai. Thekedar login banane ke liye: ${url}`
    : `${d.companyName} ne aap ko ${role} ke taur par invite kiya hai: ${url}`;

  const tasks: Promise<void>[] = [
    smsProvider()
      .send({ to: d.phone, body: sms })
      .catch((err: unknown) => logger.error({ err, phone: maskPhone(d.phone) }, 'invitation sms failed')),
  ];

  if (d.email) {
    const days = 7;
    const intro = d.newCompany
      ? `Your company "${d.companyName}" has been created on Construction Platform. Set up your Thekedar (owner) account to get started.`
      : `${d.companyName} has invited you to join as ${role} on Construction Platform.`;
    const munshiNote =
      d.role === 'MUNSHI' ? '\n\nAfter joining, sign in on the mobile app with your phone number — by password or by a login code.' : '';
    tasks.push(
      trySendMail({
        to: d.email,
        subject: d.newCompany ? `Your company ${d.companyName} is ready` : `You're invited to ${d.companyName}`,
        text: `Hi ${d.name},\n\n${intro}\n\nAccept the invitation: ${url}\n\nThis link works once and expires in ${days} days. If you weren't expecting it, ignore this email.${munshiNote}`,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#0f172a;line-height:1.5">
<p>Hi ${escapeHtml(d.name)},</p>
<p>${escapeHtml(intro)}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Accept invitation</a></p>
<p style="color:#64748b;font-size:13px">Or open this link: ${escapeHtml(url)}<br>It works once and expires in ${days} days. If you weren't expecting it, ignore this email.</p>
${munshiNote ? `<p style="color:#64748b;font-size:13px">${escapeHtml(munshiNote.trim())}</p>` : ''}
</div>`,
      }),
    );
  }
  await Promise.all(tasks);
}
