import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { DEFAULT_LANG, enumLabel, tr, type Lang } from '../../core/i18n/index.js';
import { maskPhone } from '../../core/utils/phone.js';
import type { UserRole } from '../../generated/prisma/enums.js';
import { trySendMail } from './mail.provider.js';
import { smsProvider } from './sms.provider.js';
import { trySendWhatsApp } from './whatsapp.provider.js';

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
  /** Company the invite is for (delivery log). */
  tenantId?: string | null;
  /** A brand-new company created from the platform console (owner invite). */
  newCompany?: boolean;
  /** The invite's language (SMS + email); it becomes the person's language on accept. Default Roman Urdu. */
  lang?: Lang;
}

export const INVITE_EMAIL_DAYS = 7;

/** The invite email in `lang` (exported for tests / previews). */
export function inviteEmail(d: InviteDelivery, url: string) {
  const lang = d.lang ?? DEFAULT_LANG;
  const role = enumLabel(lang, 'UserRole', d.role);
  const days = INVITE_EMAIL_DAYS;
  const intro = d.newCompany ? tr(lang, 'mail.invite.intro.newCompany', { company: d.companyName }) : tr(lang, 'mail.invite.intro.member', { company: d.companyName, role });
  const munshiNote = d.role === 'MUNSHI' ? tr(lang, 'mail.invite.munshiNote') : '';
  const rtl = lang === 'ur';
  return {
    subject: tr(lang, d.newCompany ? 'mail.invite.subject.newCompany' : 'mail.invite.subject.member', { company: d.companyName }),
    text: `${tr(lang, 'mail.greeting', { name: d.name })}\n\n${intro}\n\n${tr(lang, 'mail.invite.acceptLine', { url })}\n\n${tr(lang, 'mail.invite.expiry', { days })}${munshiNote ? `\n\n${munshiNote}` : ''}`,
    html: `<div dir="${rtl ? 'rtl' : 'ltr'}" lang="${rtl ? 'ur' : 'en'}" style="font-family:${rtl ? "'Noto Nastaliq Urdu','Jameel Noori Nastaleeq',Tahoma," : ''}Arial,sans-serif;font-size:15px;color:#0f172a;line-height:${rtl ? 2 : 1.5}">
<p>${escapeHtml(tr(lang, 'mail.greeting', { name: d.name }))}</p>
<p>${escapeHtml(intro)}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(tr(lang, 'mail.invite.button'))}</a></p>
<p style="color:#64748b;font-size:13px">${escapeHtml(tr(lang, 'mail.invite.orOpen', { url }))}<br>${escapeHtml(tr(lang, 'mail.invite.expiry', { days }))}</p>
${munshiNote ? `<p style="color:#64748b;font-size:13px">${escapeHtml(munshiNote)}</p>` : ''}
</div>`,
  };
}

/**
 * Sends the one-time invite link by SMS, by email when the invite has one, and by WhatsApp when
 * WHATSAPP_ENABLED (the web / mobile share links stay the fallback) — in the invite's language.
 * Best effort: the invitation stays valid if delivery fails (it can be resent). The token is
 * never logged.
 */
export async function deliverInvite(d: InviteDelivery): Promise<void> {
  const lang = d.lang ?? DEFAULT_LANG;
  const url = inviteUrl(d.token);
  const role = enumLabel(lang, 'UserRole', d.role);
  const sms = d.newCompany ? tr(lang, 'sms.invite.newCompany', { company: d.companyName, url }) : tr(lang, 'sms.invite.member', { company: d.companyName, role, url });

  const tasks: Promise<unknown>[] = [
    smsProvider()
      .send({ to: d.phone, body: sms, type: 'INVITE', tenantId: d.tenantId, params: { name: d.name, company: d.companyName, role, url }, lang })
      .catch((err: unknown) => logger.error({ err, phone: maskPhone(d.phone) }, 'invitation sms failed')),
  ];

  if (d.email) tasks.push(trySendMail({ to: d.email, type: 'INVITE', tenantId: d.tenantId, ...inviteEmail(d, url) }));
  tasks.push(trySendWhatsApp({ to: d.phone, type: 'INVITE', params: [d.name, d.companyName, role, url], tenantId: d.tenantId }));
  await Promise.all(tasks);
}
