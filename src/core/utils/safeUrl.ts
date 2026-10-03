/** Invitation *ids* are UUIDs (fine to log); accept *tokens* are not. */
const INVITE_TOKEN = /\/invitations\/(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|$))[^/]+/i;

/**
 * Removes secrets that can appear in URLs before they are logged or echoed:
 *  - invitation tokens:  /invitations/<token>/accept → /invitations/[REDACTED]/accept
 *  - signed file links:  /attachments/<id>/file?tid&exp&sig → query replaced by [REDACTED]
 */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q + 1);
  const cleanPath = path.replace(INVITE_TOKEN, '/invitations/[REDACTED]');
  if (!query) return cleanPath;
  return `${cleanPath}?${path.includes('/attachments/') ? '[REDACTED]' : query}`;
}
