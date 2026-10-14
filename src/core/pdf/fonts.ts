/**
 * Urdu font for PDFs. Chromium (Playwright) on a slim Linux image has no Urdu font, so Urdu PDFs
 * embed Noto Nastaliq Urdu (SIL OFL 1.1, assets/fonts) as a base64 @font-face — no CDN, no system
 * font needed. If the file is missing the CSS falls back to system Urdu / Arabic fonts (Jameel
 * Noori Nastaleeq, Urdu Typesetting, Segoe UI, Tahoma, Arial on Windows; Noto Naskh / DejaVu
 * on Linux when installed) and a warning is logged once.
 */
import { readFileSync } from 'node:fs';
import { logger } from '../../config/logger.js';

// src/core/pdf → repo root (dist/core/pdf the same depth).
const FONT_URL = new URL('../../../assets/fonts/NotoNastaliqUrdu-arabic.woff2', import.meta.url);

export const URDU_FONT_FAMILY = "'Noto Nastaliq Urdu', 'Jameel Noori Nastaleeq', 'Urdu Typesetting', 'Noto Naskh Arabic', 'Segoe UI', Tahoma, Arial, sans-serif";

let cached: string | null | undefined;

/** The @font-face rule with the embedded font ('' when the file can't be read). */
export function urduFontFace(): string {
  if (cached === undefined) {
    try {
      cached = readFileSync(FONT_URL).toString('base64');
    } catch (err) {
      logger.warn({ err }, 'Urdu PDF font not found (assets/fonts) — using system fonts');
      cached = null;
    }
  }
  if (!cached) return '';
  return `@font-face { font-family: 'Noto Nastaliq Urdu'; font-style: normal; font-weight: 400 700; src: url(data:font/woff2;base64,${cached}) format('woff2'); }`;
}
