/**
 * HTML → PDF with Playwright's chromium (A4, page numbers in the footer). One browser is
 * kept per process and reused; a crash or a missing browser becomes 503 PDF_UNAVAILABLE.
 * Tests swap the renderer with `setPdfRenderer` so no browser is needed.
 *
 * Windows / fresh machines: `npx playwright install chromium` once.
 */
import type { Browser } from 'playwright';
import { logger } from '../../config/logger.js';
import { AppError } from '../errors/AppError.js';
import type { Lang } from '../i18n/lang.js';
import { pdfFooter } from './templates.js';

export interface PdfRenderer {
  render(html: string, opts: { footerText: string; lang: Lang }): Promise<Buffer>;
}

export const pdfUnavailable = () => new AppError(503, 'PDF_UNAVAILABLE', 'PDFs cannot be made right now — try again in a minute');

let browser: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = import('playwright').then(({ chromium }) => chromium.launch({ args: ['--no-sandbox'] }));
    browser.catch(() => {
      browser = null;
    });
  }
  return browser;
}

const chromiumRenderer: PdfRenderer = {
  async render(html, { footerText, lang }) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      return await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '14mm', bottom: '18mm', left: '14mm', right: '14mm' },
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: pdfFooter(footerText, lang),
      });
    } finally {
      await page.close();
    }
  },
};

let current: PdfRenderer = chromiumRenderer;

/** Tests: replace the renderer (pass null to restore chromium). */
export function setPdfRenderer(r: PdfRenderer | null) {
  current = r ?? chromiumRenderer;
}

/** `lang`: the document language (footer labels / direction; the HTML carries its own). */
export async function renderPdf(html: string, footerText: string, lang: Lang = 'en'): Promise<Buffer> {
  try {
    return await current.render(html, { footerText, lang });
  } catch (err) {
    logger.warn({ err }, 'pdf render failed');
    throw pdfUnavailable();
  }
}
