/**
 * Server-side languages. The API speaks the short codes the apps use (`en` | `roman` | `ur`);
 * the database keeps the older `Language` enum (ENGLISH | ROMAN_URDU | URDU) — convert at the
 * edges with `langOf` / `dbLanguage`.
 */
import { z } from 'zod';
import type { Language } from '../../generated/prisma/enums.js';

export const LANGS = ['en', 'roman', 'ur'] as const;
export type Lang = (typeof LANGS)[number];

/** Roman Urdu: what most site staff read; the default for new users and invites. */
export const DEFAULT_LANG: Lang = 'roman';

const FROM_DB: Record<Language, Lang> = { ENGLISH: 'en', ROMAN_URDU: 'roman', URDU: 'ur' };
const TO_DB: Record<Lang, Language> = { en: 'ENGLISH', roman: 'ROMAN_URDU', ur: 'URDU' };

/** DB enum (or null / unknown) → short code. */
export const langOf = (language: Language | string | null | undefined): Lang =>
  (language && (FROM_DB as Record<string, Lang>)[language]) || (isLang(language) ? language : DEFAULT_LANG);

/** Short code → DB enum. */
export const dbLanguage = (lang: Lang): Language => TO_DB[lang];

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);

/** Urdu runs right-to-left. */
export const isRtl = (lang: Lang) => lang === 'ur';

/** `en` | `roman` | `ur` in requests and responses. */
export const langSchema = z.enum(LANGS, { error: 'language must be en, roman or ur' }).meta({ description: 'en = English, roman = Roman Urdu, ur = Urdu (right-to-left)', example: 'ur' });

/** Optional `?lang=` on document / export endpoints (default: the signed-in user's language). */
export const langQuery = z.object({ lang: langSchema.optional() });
