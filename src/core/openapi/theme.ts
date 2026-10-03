/**
 * Light theme for Swagger UI at /api/docs: white surfaces, slate text, blue actions,
 * a thin construction-amber accent, compact tables and tinted operation rows.
 * Pure CSS — helmet's CSP allows inline styles and https fonts; no inline scripts.
 */
export const swaggerCss = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --accent: #f59e0b;
  --primary: #2563eb;
  --primary-dark: #1d4ed8;
  --ink: #0f172a;
  --ink-2: #334155;
  --muted: #64748b;
  --line: #e2e8f0;
  --soft: #f1f5f9;
  --surface: #ffffff;
  --page: #f8fafc;
  --get: #2563eb;
  --post: #059669;
  --patch: #d97706;
  --put: #7c3aed;
  --delete: #dc2626;
}

html, body { background: var(--page); }
body { margin: 0; border-top: 4px solid var(--accent); }
.swagger-ui, .swagger-ui .info, .swagger-ui .opblock-tag, .swagger-ui table, .swagger-ui .btn,
.swagger-ui select, .swagger-ui input, .swagger-ui label, .swagger-ui .model, .swagger-ui .response-col_status,
.swagger-ui .parameter__name, .swagger-ui .opblock .opblock-summary-description, .swagger-ui .markdown p,
.swagger-ui .renderedMarkdown p, .swagger-ui .tab li, .swagger-ui .opblock-description-wrapper p {
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif !important;
}
.swagger-ui code, .swagger-ui pre, .swagger-ui .microlight, .swagger-ui .opblock-summary-path,
.swagger-ui .opblock-summary-path__deprecated, .swagger-ui .model-box, .swagger-ui textarea {
  font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace !important;
}

/* ── Header ─────────────────────────────────────────────────────────── */
.swagger-ui .topbar { display: none; }
.swagger-ui .information-container.wrapper { padding-top: 8px; }
.swagger-ui .info { margin: 28px 0 8px; }
.swagger-ui .info .title { color: var(--ink); font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
.swagger-ui .info .title::before { content: '🏗️ '; }
.swagger-ui .info .title small {
  border-radius: 999px; padding: 3px 10px; font-weight: 600; top: -4px;
  background: #fef3c7; border: 1px solid #fcd34d;
}
.swagger-ui .info .title small pre { color: #92400e; font-family: inherit !important; }
.swagger-ui .info .title small.version-stamp { background: var(--soft); border-color: var(--line); }
.swagger-ui .info .title small.version-stamp pre { color: var(--ink-2); }

/* ── Overview markdown ──────────────────────────────────────────────── */
.swagger-ui .info .description { max-width: 960px; }
.swagger-ui .info .description .markdown,
.swagger-ui .info .description .renderedMarkdown { color: var(--ink-2); font-size: 14.5px; line-height: 1.65; }
.swagger-ui .info .description h3 {
  color: var(--ink); font-size: 17px; font-weight: 700; margin: 28px 0 10px;
  font-family: 'Inter', sans-serif !important;
}
.swagger-ui .info .description p { margin: 8px 0; }
.swagger-ui .info .description ol, .swagger-ui .info .description ul { padding-left: 22px; margin: 6px 0; }
.swagger-ui .info .description li { margin: 4px 0; }
.swagger-ui .info .description table {
  border-collapse: separate; border-spacing: 0; width: 100%; margin: 8px 0 6px; font-size: 13.5px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
}
.swagger-ui .info .description th {
  background: var(--soft); color: var(--ink); text-align: left; font-weight: 600;
  padding: 9px 12px; border-bottom: 1px solid var(--line);
}
.swagger-ui .info .description td { padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; color: var(--ink-2); }
.swagger-ui .info .description tr:last-child td { border-bottom: none; }
.swagger-ui .info .description code {
  background: var(--soft); color: var(--ink); border: 1px solid var(--line);
  border-radius: 5px; padding: 1px 6px; font-size: 12.5px; font-weight: 500;
}
.swagger-ui .info .description pre {
  background: var(--surface) !important; border: 1px solid var(--line); border-radius: 10px;
  padding: 14px 16px; margin: 6px 0 12px; max-width: 640px;
}
.swagger-ui .info .description pre code { background: none; border: none; padding: 0; color: var(--ink-2); font-size: 13px; }
.swagger-ui .info .description blockquote {
  margin: 14px 0; padding: 10px 14px; background: #eff6ff; border: 1px solid #bfdbfe;
  border-left: 4px solid var(--primary); border-radius: 8px; color: var(--ink-2);
}
.swagger-ui .info .description blockquote p { margin: 0; }

/* ── Servers + Authorize bar ────────────────────────────────────────── */
.swagger-ui .wrapper { max-width: 1200px; padding: 0 24px; }
.swagger-ui .scheme-container {
  background: var(--surface); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
  box-shadow: none; padding: 16px 0; margin: 24px 0 0;
}
.swagger-ui .scheme-container .schemes { align-items: center; }
.swagger-ui .scheme-container .schemes > label { color: var(--muted); font-weight: 600; font-size: 12px; }
.swagger-ui select { border-radius: 8px; border: 1px solid var(--line); box-shadow: none; }
.swagger-ui .filter-container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
.swagger-ui .filter .operation-filter-input {
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin: 16px 0 8px; background: var(--surface);
}
.swagger-ui .filter .operation-filter-input:focus { outline: 2px solid #bfdbfe; border-color: var(--primary); }

/* ── Buttons ────────────────────────────────────────────────────────── */
.swagger-ui .btn { border-radius: 8px; font-weight: 600; box-shadow: none; }
.swagger-ui .btn.authorize { background: var(--primary); border-color: var(--primary); color: #fff; padding: 8px 18px; }
.swagger-ui .btn.authorize svg { fill: #fff; }
.swagger-ui .btn.authorize:hover { background: var(--primary-dark); }
.swagger-ui .btn.execute { background: var(--primary); border-color: var(--primary); }
.swagger-ui .btn.try-out__btn { border-color: var(--primary); color: var(--primary); }
.swagger-ui .btn.try-out__btn.cancel { border-color: var(--delete); color: var(--delete); }
.swagger-ui .btn-clear { border-color: var(--line); }

/* ── Tags ───────────────────────────────────────────────────────────── */
.swagger-ui .opblock-tag-section { margin-bottom: 8px; }
.swagger-ui .opblock-tag { border-bottom: 1px solid var(--line); padding: 16px 4px 10px; margin-bottom: 12px; color: var(--ink); font-size: 20px; font-weight: 700; }
.swagger-ui .opblock-tag small { color: var(--muted); font-size: 13.5px; font-weight: 400; padding-left: 12px; }
.swagger-ui .opblock-tag:hover { background: transparent; }

/* ── Operations ─────────────────────────────────────────────────────── */
.swagger-ui .opblock { border-radius: 10px; border-width: 1px; margin: 0 0 8px; box-shadow: none; overflow: hidden; }
.swagger-ui .opblock .opblock-summary { padding: 6px 10px; }
.swagger-ui .opblock .opblock-summary-method { border-radius: 6px; min-width: 70px; font-weight: 700; font-size: 12px; padding: 6px 0; text-shadow: none; }
.swagger-ui .opblock .opblock-summary-path { font-size: 13.5px; font-weight: 500; color: var(--ink); }
.swagger-ui .opblock .opblock-summary-description { color: var(--muted); font-size: 13.5px; }
.swagger-ui .opblock .opblock-section-header { background: var(--page); box-shadow: none; border-bottom: 1px solid var(--line); }
.swagger-ui .opblock .opblock-section-header h4 { font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-2); }
.swagger-ui .opblock-body { background: var(--surface); }
.swagger-ui .opblock-description-wrapper p { color: var(--ink-2); font-size: 14px; }
.swagger-ui .opblock-description-wrapper code { background: var(--soft); border-radius: 4px; padding: 1px 5px; color: var(--ink); }

.swagger-ui .opblock.opblock-get    { border-color: #bfdbfe; background: #f5f9ff; }
.swagger-ui .opblock.opblock-get .opblock-summary-method    { background: var(--get); }
.swagger-ui .opblock.opblock-get .opblock-summary           { border-color: #bfdbfe; }
.swagger-ui .opblock.opblock-post   { border-color: #a7f3d0; background: #f3fcf8; }
.swagger-ui .opblock.opblock-post .opblock-summary-method   { background: var(--post); }
.swagger-ui .opblock.opblock-post .opblock-summary          { border-color: #a7f3d0; }
.swagger-ui .opblock.opblock-patch  { border-color: #fde68a; background: #fffcf2; }
.swagger-ui .opblock.opblock-patch .opblock-summary-method  { background: var(--patch); }
.swagger-ui .opblock.opblock-patch .opblock-summary         { border-color: #fde68a; }
.swagger-ui .opblock.opblock-put    { border-color: #ddd6fe; background: #faf8ff; }
.swagger-ui .opblock.opblock-put .opblock-summary-method    { background: var(--put); }
.swagger-ui .opblock.opblock-put .opblock-summary           { border-color: #ddd6fe; }
.swagger-ui .opblock.opblock-delete { border-color: #fecaca; background: #fff7f7; }
.swagger-ui .opblock.opblock-delete .opblock-summary-method { background: var(--delete); }
.swagger-ui .opblock.opblock-delete .opblock-summary        { border-color: #fecaca; }

.swagger-ui .authorization__btn svg { fill: var(--muted); }

/* ── Request examples, code and tables ──────────────────────────────── */
.swagger-ui .examples-select { margin: 4px 0 10px; }
.swagger-ui .examples-select > select { min-width: 320px; padding: 6px 10px; font-weight: 500; }
.swagger-ui .examples-select__section-label { font-weight: 600; color: var(--ink-2); }
.swagger-ui .opblock-body pre.microlight, .swagger-ui .highlight-code > .microlight {
  background: var(--page) !important; color: var(--ink) !important; border: 1px solid var(--line);
  border-radius: 8px; padding: 12px !important; font-size: 12.5px;
}
.swagger-ui textarea { border-radius: 8px; border: 1px solid var(--line); background: var(--surface); }
.swagger-ui .body-param__text { min-height: 180px; font-size: 13px; }
.swagger-ui .parameters-col_description input { border-radius: 8px; border: 1px solid var(--line); }
.swagger-ui table thead tr th, .swagger-ui table thead tr td { color: var(--ink-2); font-weight: 600; border-bottom: 1px solid var(--line); }
.swagger-ui .response-col_status { font-weight: 700; color: var(--ink); }
.swagger-ui .response-col_description__inner p { color: var(--ink-2); }
.swagger-ui .responses-table .response .response-col_description .markdown p { font-family: 'JetBrains Mono', monospace !important; font-size: 12.5px; }

/* ── Schemas ────────────────────────────────────────────────────────── */
.swagger-ui section.models { border-radius: 10px; border-color: var(--line); background: var(--surface); }
.swagger-ui section.models h4 { color: var(--ink); font-weight: 700; }
.swagger-ui section.models .model-container { border-radius: 8px; background: var(--page); }

/* ── Authorize dialog ───────────────────────────────────────────────── */
.swagger-ui .dialog-ux .modal-ux { border-radius: 14px; border: 1px solid var(--line); box-shadow: 0 25px 60px -15px rgba(15,23,42,.35); }
.swagger-ui .dialog-ux .modal-ux-header h3 { font-weight: 700; color: var(--ink); }
.swagger-ui .auth-container input[type=text], .swagger-ui .auth-container input[type=password] {
  border-radius: 8px; border: 1px solid var(--line); padding: 9px 12px;
}

/* ── Phones ─────────────────────────────────────────────────────────── */
.swagger-ui .information-container .info, .swagger-ui .wrapper, .swagger-ui .filter-container { box-sizing: border-box; width: 100%; }
@media (max-width: 640px) {
  .swagger-ui .wrapper, .swagger-ui .filter-container { padding-left: 16px; padding-right: 16px; }
  .swagger-ui .info .title { font-size: 22px; line-height: 1.3; }
  .swagger-ui .info .title small { top: 0; }
  .swagger-ui .info .description table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .swagger-ui .info .description th, .swagger-ui .info .description td { min-width: 110px; }
  .swagger-ui .info .description td code { white-space: nowrap; display: inline-block; margin: 1px 0; }
  .swagger-ui .examples-select > select { min-width: 0; width: 100%; }
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
