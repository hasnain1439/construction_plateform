/**
 * QA-B-20 · the language of server-made texts in a response.
 *
 * The web app sends its UI language in `X-Lang: en | roman | ur` on every request (the mobile app
 * sends nothing). Texts the server writes FOR THE REQUESTING USER follow it:
 *
 *   responseLang(tx, userId)  X-Lang, else the user's account language (User.language)
 *                             — alert titles / bodies, notification inbox, tax adviser note,
 *                             delay notes, plan-version notes, documents / exports without ?lang
 *   jsonLang()                X-Lang, else English — free text inside report JSON (subtitle,
 *                             notes, reason cells) that used to be English only
 *
 * Texts for OTHER people (notifications, SMS, e-mail, WhatsApp to the owner) never use it: they are
 * in the recipient's language. An explicit `?lang=` on documents / exports always wins.
 */
import { tryGetCtx } from '../context/requestContext.js';
import type { Tx } from '../db/withTenant.js';
import { langOf, type Lang } from './lang.js';

/** The valid X-Lang of the current request, if any. */
export const requestUiLang = (): Lang | undefined => tryGetCtx()?.uiLang;

/** X-Lang when the reader is the requesting user, else (or without it) the account language. */
export async function responseLang(tx: Tx, userId: string | null | undefined): Promise<Lang> {
  const ctx = tryGetCtx();
  if (ctx?.uiLang && (!userId || userId === ctx.userId)) return ctx.uiLang;
  if (!userId) return 'en';
  const u = await tx.user.findUnique({ where: { id: userId }, select: { language: true } });
  return langOf(u?.language);
}

/** Report JSON free text: X-Lang, else English (the old behaviour). */
export const jsonLang = (): Lang => requestUiLang() ?? 'en';
