/**
 * Pakistani mobile numbers, normalised to E.164 (+923XXXXXXXXX).
 *
 *   03001234567      → +923001234567
 *   +92 300 1234567  → +923001234567
 *   923001234567     → +923001234567
 *   0092-300-1234567 → +923001234567
 */
const E164_PK_MOBILE = /^\+923\d{9}$/;

export function normalizePkPhone(input: string): string | null {
  let digits = input.trim().replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('0092')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;

  let national: string;
  if (digits.startsWith('92') && digits.length === 12) national = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 11) national = digits.slice(1);
  else if (digits.length === 10) national = digits;
  else return null;

  const e164 = `+92${national}`;
  return E164_PK_MOBILE.test(e164) ? e164 : null;
}

export function isValidPkPhone(input: string): boolean {
  return normalizePkPhone(input) !== null;
}

/** "+923001234567" → "+92300*****67" for logs and messages. */
export function maskPhone(phone: string): string {
  return phone.length > 8 ? `${phone.slice(0, 6)}*****${phone.slice(-2)}` : '***';
}
