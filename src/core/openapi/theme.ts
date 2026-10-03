/**
 * Custom look for Swagger UI at /api/docs: construction amber + slate, Inter font,
 * a branded header, cleaner operation blocks. Pure CSS (helmet's CSP allows inline
 * styles and https fonts; no inline scripts are needed).
 */
export const swaggerCss = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --brand: #f59e0b;
  --brand-dark: #b45309;
  --ink: #0f172a;
  --ink-2: #334155;
  --muted: #64748b;
  --line: #e2e8f0;
  --surface: #ffffff;
  --page: #f8fafc;
  --get: #2563eb;
  --post: #059669;
  --patch: #d97706;
  --put: #7c3aed;
  --delete: #dc2626;
}

body { background: var(--page); margin: 0; }
.swagger-ui, .swagger-ui .info, .swagger-ui .opblock-tag, .swagger-ui table, .swagger-ui .btn,
.swagger-ui select, .swagger-ui input, .swagger-ui textarea, .swagger-ui .model, .swagger-ui .response-col_status,
.swagger-ui .parameter__name, .swagger-ui .opblock .opblock-summary-description {
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif !important;
}
.swagger-ui code, .swagger-ui pre, .swagger-ui .microlight, .swagger-ui .opblock-summary-path,
.swagger-ui .opblock-summary-path__deprecated, .swagger-ui .model-box, .swagger-ui textarea.curl {
  font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace !important;
}

/* ── Header ─────────────────────────────────────────────────────────── */
.swagger-ui .topbar { display: none; }
.swagger-ui .information-container.wrapper {
  max-width: none;
  padding: 0;
  background:
    repeating-linear-gradient(-45deg, rgba(245,158,11,.10) 0 14px, transparent 14px 28px),
    linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
  border-bottom: 4px solid var(--brand);
}
.swagger-ui .information-container .info {
  max-width: 1200px;
  margin: 0 auto;
  padding: 36px 24px 28px;
}
.swagger-ui .info .title {
  color: #fff;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.swagger-ui .info .title::before { content: '🏗️ '; }
.swagger-ui .info .title small {
  background: var(--brand);
  color: var(--ink);
  border-radius: 999px;
  padding: 3px 10px;
  font-weight: 600;
  top: -6px;
}
.swagger-ui .info .title small.version-stamp { background: #fff; }
.swagger-ui .info .title small pre { color: var(--ink); font-family: inherit !important; }
.swagger-ui .info a.link, .swagger-ui .info .base-url { color: #cbd5e1; }

/* Overview markdown sits on a white card under the dark banner */
.swagger-ui .info .description {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 8px 28px 20px;
  margin-top: 24px;
  box-shadow: 0 10px 30px -12px rgba(15,23,42,.35);
}
.swagger-ui .info .description .markdown,
.swagger-ui .info .description .renderedMarkdown { color: var(--ink-2); font-size: 14.5px; line-height: 1.65; }
.swagger-ui .info .description h2 {
  color: var(--ink);
  font-size: 19px;
  font-weight: 700;
  margin: 26px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
}
.swagger-ui .info .description table { border-collapse: collapse; width: 100%; margin: 8px 0 4px; font-size: 13.5px; }
.swagger-ui .info .description th {
  background: #f1f5f9; color: var(--ink); text-align: left; font-weight: 600;
  padding: 8px 12px; border: 1px solid var(--line);
}
.swagger-ui .info .description td { padding: 8px 12px; border: 1px solid var(--line); vertical-align: top; }
.swagger-ui .info .description tr:nth-child(even) td { background: #fafafa; }
.swagger-ui .info .description code {
  background: #fff7ed; color: var(--brand-dark); border: 1px solid #fed7aa;
  border-radius: 5px; padding: 1px 5px; font-size: 12.5px;
}
.swagger-ui .info .description blockquote {
  margin: 12px 0; padding: 10px 14px; background: #eff6ff;
  border-left: 4px solid var(--get); border-radius: 0 8px 8px 0; color: var(--ink-2);
}
.swagger-ui .info .description ol, .swagger-ui .info .description ul { padding-left: 22px; }
.swagger-ui .info .description li { margin: 3px 0; }

/* ── Layout ─────────────────────────────────────────────────────────── */
.swagger-ui .wrapper { max-width: 1200px; padding: 0 24px; }
.swagger-ui .scheme-container {
  background: transparent; box-shadow: none; padding: 18px 0 4px; margin: 0;
}
.swagger-ui .scheme-container .schemes { align-items: center; }
.swagger-ui .filter-container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
.swagger-ui .filter .operation-filter-input {
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin: 12px 0;
  box-shadow: 0 1px 2px rgba(15,23,42,.05);
}
.swagger-ui .filter .operation-filter-input:focus { outline: 2px solid var(--brand); border-color: var(--brand); }

/* ── Buttons ────────────────────────────────────────────────────────── */
.swagger-ui .btn { border-radius: 8px; font-weight: 600; box-shadow: none; }
.swagger-ui .btn.authorize {
  background: var(--brand); border-color: var(--brand); color: var(--ink);
  padding: 8px 18px;
}
.swagger-ui .btn.authorize svg { fill: var(--ink); }
.swagger-ui .btn.authorize.locked { background: #10b981; border-color: #10b981; color: #fff; }
.swagger-ui .btn.authorize.locked svg { fill: #fff; }
.swagger-ui .btn.execute { background: var(--ink); border-color: var(--ink); }
.swagger-ui .btn.try-out__btn { border-color: var(--brand); color: var(--brand-dark); }
.swagger-ui .btn.try-out__btn.cancel { border-color: var(--delete); color: var(--delete); }

/* ── Tags ───────────────────────────────────────────────────────────── */
.swagger-ui .opblock-tag-section { margin-bottom: 10px; }
.swagger-ui .opblock-tag {
  border-bottom: none; padding: 14px 4px; color: var(--ink); font-size: 20px; font-weight: 700;
}
.swagger-ui .opblock-tag small { color: var(--muted); font-size: 13.5px; font-weight: 400; padding-left: 12px; }
.swagger-ui .opblock-tag:hover { background: transparent; }

/* ── Operations ─────────────────────────────────────────────────────── */
.swagger-ui .opblock {
  border-radius: 12px; border-width: 1px; margin: 0 0 10px;
  box-shadow: 0 1px 2px rgba(15,23,42,.06); overflow: hidden; background: var(--surface);
}
.swagger-ui .opblock .opblock-summary { padding: 8px 12px; }
.swagger-ui .opblock .opblock-summary-method {
  border-radius: 7px; min-width: 72px; font-weight: 700; font-size: 12.5px; padding: 7px 0; text-shadow: none;
}
.swagger-ui .opblock .opblock-summary-path { font-size: 14px; font-weight: 500; color: var(--ink); }
.swagger-ui .opblock .opblock-summary-description { color: var(--muted); font-size: 13.5px; }
.swagger-ui .opblock .opblock-section-header { background: #f8fafc; box-shadow: none; border-bottom: 1px solid var(--line); }
.swagger-ui .opblock .opblock-section-header h4 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-2); }
.swagger-ui .opblock-description-wrapper p, .swagger-ui .opblock-external-docs-wrapper p { color: var(--ink-2); font-size: 14px; }

.swagger-ui .opblock.opblock-get    { border-color: #bfdbfe; background: var(--surface); }
.swagger-ui .opblock.opblock-get .opblock-summary-method    { background: var(--get); }
.swagger-ui .opblock.opblock-get .opblock-summary           { border-color: #bfdbfe; background: #eff6ff; }
.swagger-ui .opblock.opblock-post   { border-color: #a7f3d0; background: var(--surface); }
.swagger-ui .opblock.opblock-post .opblock-summary-method   { background: var(--post); }
.swagger-ui .opblock.opblock-post .opblock-summary          { border-color: #a7f3d0; background: #ecfdf5; }
.swagger-ui .opblock.opblock-patch  { border-color: #fde68a; background: var(--surface); }
.swagger-ui .opblock.opblock-patch .opblock-summary-method  { background: var(--patch); }
.swagger-ui .opblock.opblock-patch .opblock-summary         { border-color: #fde68a; background: #fffbeb; }
.swagger-ui .opblock.opblock-put    { border-color: #ddd6fe; background: var(--surface); }
.swagger-ui .opblock.opblock-put .opblock-summary-method    { background: var(--put); }
.swagger-ui .opblock.opblock-put .opblock-summary           { border-color: #ddd6fe; background: #f5f3ff; }
.swagger-ui .opblock.opblock-delete { border-color: #fecaca; background: var(--surface); }
.swagger-ui .opblock.opblock-delete .opblock-summary-method { background: var(--delete); }
.swagger-ui .opblock.opblock-delete .opblock-summary        { border-color: #fecaca; background: #fef2f2; }

/* Lock icon on secured routes */
.swagger-ui .authorization__btn svg { fill: var(--muted); }
.swagger-ui .authorization__btn.locked svg { fill: var(--post); }

/* ── Code & tables ──────────────────────────────────────────────────── */
.swagger-ui .highlight-code > .microlight, .swagger-ui .opblock-body pre.microlight {
  background: #0f172a !important; border-radius: 10px; padding: 14px !important; font-size: 12.5px;
}
.swagger-ui textarea { border-radius: 8px; border-color: var(--line); }
.swagger-ui .body-param__text { min-height: 180px; font-size: 13px; }
.swagger-ui table thead tr th, .swagger-ui table thead tr td { color: var(--ink-2); font-weight: 600; border-bottom: 1px solid var(--line); }
.swagger-ui .responses-inner h4, .swagger-ui .responses-inner h5 { color: var(--ink); }
.swagger-ui .response-col_status { font-weight: 700; color: var(--ink); }
.swagger-ui .response-col_description__inner p { color: var(--ink-2); }
.swagger-ui .responses-table .response .response-col_description .markdown p { font-family: 'JetBrains Mono', monospace !important; font-size: 12.5px; }

/* ── Schemas section ────────────────────────────────────────────────── */
.swagger-ui section.models { border-radius: 12px; border-color: var(--line); background: var(--surface); }
.swagger-ui section.models h4 { color: var(--ink); font-weight: 700; }
.swagger-ui section.models .model-container { border-radius: 8px; background: #f8fafc; }

/* ── Authorize dialog ───────────────────────────────────────────────── */
.swagger-ui .dialog-ux .modal-ux { border-radius: 14px; border: none; box-shadow: 0 25px 60px -15px rgba(15,23,42,.5); }
.swagger-ui .dialog-ux .modal-ux-header { border-bottom: 1px solid var(--line); }
.swagger-ui .dialog-ux .modal-ux-header h3 { font-weight: 700; color: var(--ink); }
.swagger-ui .auth-container input[type=text], .swagger-ui .auth-container input[type=password] {
  border-radius: 8px; border: 1px solid var(--line); padding: 9px 12px;
}

/* ── Phones ─────────────────────────────────────────────────────────── */
.swagger-ui .information-container .info, .swagger-ui .info .description,
.swagger-ui .wrapper, .swagger-ui .filter-container { box-sizing: border-box; width: 100%; }
.swagger-ui .info .description code { overflow-wrap: anywhere; }

@media (max-width: 640px) {
  .swagger-ui .wrapper, .swagger-ui .information-container .info, .swagger-ui .filter-container { padding-left: 16px; padding-right: 16px; }
  .swagger-ui .info .title { font-size: 22px; line-height: 1.3; }
  .swagger-ui .info .title small { top: 0; }
  .swagger-ui .info .description { padding: 4px 16px 16px; font-size: 14px; }
  .swagger-ui .info .description .markdown, .swagger-ui .info .description .renderedMarkdown { font-size: 14px; }
  /* Wide tables scroll inside the card instead of widening the page */
  .swagger-ui .info .description table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .swagger-ui .info .description th, .swagger-ui .info .description td { min-width: 120px; padding: 7px 10px; }
  .swagger-ui .info .description td:last-child { min-width: 220px; }
  /* Keep code chips whole inside tables; the table scrolls instead */
  .swagger-ui .info .description td code { white-space: nowrap; overflow-wrap: normal; display: inline-block; margin: 1px 0; }
  .swagger-ui .opblock .opblock-summary { flex-wrap: wrap; }
  .swagger-ui .opblock .opblock-summary-method { min-width: 56px; font-size: 11px; }
  .swagger-ui .opblock .opblock-summary-path { font-size: 12.5px; word-break: break-all; }
}
`;

/** Hard-hat favicon as an inline SVG data URI. */
export const swaggerFavicon =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M14 42a18 18 0 0 1 36 0z" fill="#f59e0b"/><rect x="10" y="42" width="44" height="6" rx="3" fill="#f59e0b"/><rect x="29" y="20" width="6" height="14" rx="3" fill="#0f172a"/></svg>`,
  );
