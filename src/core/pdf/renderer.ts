/**
 * HTML → PDF with Playwright's chromium (A4, page numbers in the footer). One browser is
 * kept per process and reused; a crash or a missing browser becomes 503 PDF_UNAVAILABLE.
 * Tests swap the renderer with `setPdfRenderer` so no browser is needed.
 *
 * Windows / fresh machines: `npx playwright install chromium` once.
 */
import type { Browser } from 'playwright';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../errors/AppError.js';
import type { Lang } from '../i18n/lang.js';
import { todayIn } from '../utils/dates.js';
import { pdfFooter } from './templates.js';

export interface PdfLayout {
  /** QA-B-03 / QA-B-12: A4 landscape (wide report tables). */
  landscape?: boolean;
}

export interface PdfRenderer {
  render(html: string, opts: { footerText: string; lang: Lang } & PdfLayout): Promise<Buffer>;
}

export const pdfUnavailable = () => new AppError(503, 'PDF_UNAVAILABLE', 'PDFs cannot be made right now — try again in a minute');
export const pdfBusy = () => new AppError(503, 'SERVICE_BUSY', 'The server is busy making other PDFs. Please try again in a moment.');

/**
 * QA-B-23 · PDF queue: at most PDF_MAX_CONCURRENT pages render at once (Chromium is CPU-heavy);
 * the rest wait in order up to PDF_QUEUE_WAIT_MS (default 30 s) instead of failing — a burst of a few
 * PDFs from 3 users just queues. Waiting longer than that → 503 SERVICE_BUSY (retry).
 */
class PdfQueue {
  private running = 0;
  private readonly waiting: Array<{ start: () => void; timer: NodeJS.Timeout }> = [];

  constructor(
    private readonly max: () => number,
    private readonly waitMs: () => number,
  ) {}

  get stats() {
    return { running: this.running, waiting: this.waiting.length };
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.max()) {
      await new Promise<void>((resolve, reject) => {
        const entry = {
          start: () => {
            clearTimeout(entry.timer);
            resolve();
          },
          timer: setTimeout(() => {
            const i = this.waiting.indexOf(entry);
            if (i >= 0) this.waiting.splice(i, 1);
            reject(pdfBusy());
          }, this.waitMs()),
        };
        this.waiting.push(entry);
      });
    } else this.running += 1;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next.start();
      else this.running -= 1;
    }
  }
}

export const pdfQueue = new PdfQueue(
  () => env.PDF_MAX_CONCURRENT,
  () => env.PDF_QUEUE_WAIT_MS,
);

/**
 * The page setup every PDF shares (Step 18): A4, the same margins, backgrounds, an empty header
 * and the footer with the footer text, generated-on date (Pakistan time) and "Page X of Y".
 */
export function pdfPageOptions(footerText: string, lang: Lang, generatedOn: string = todayIn('Asia/Karachi'), layout: PdfLayout = {}) {
  return {
    format: 'A4' as const,
    landscape: Boolean(layout.landscape),
    printBackground: true,
    margin: { top: '14mm', bottom: '18mm', left: '14mm', right: '14mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: pdfFooter(footerText, lang, generatedOn),
  };
}

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
  async render(html, { footerText, lang, landscape }) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      return await page.pdf(pdfPageOptions(footerText, lang, undefined, { landscape }));
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

/**
 * `lang`: the document language (footer labels / direction; the HTML carries its own).
 * `layout.landscape`: A4 landscape (wide report tables). Runs through the PDF queue.
 */
export async function renderPdf(html: string, footerText: string, lang: Lang = 'en', layout: PdfLayout = {}): Promise<Buffer> {
  return pdfQueue.run(async () => {
    try {
      return await current.render(html, { footerText, lang, ...(layout.landscape ? { landscape: true } : {}) });
    } catch (err) {
      logger.warn({ err }, 'pdf render failed');
      throw pdfUnavailable();
    }
  });
}
