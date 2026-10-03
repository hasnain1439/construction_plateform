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

/**
 * Mobile or landline (office numbers), normalised to E.164.
 *   042-35761234 → +924235761234   051 1234567 → +92511234567
 * Landlines are 9–10 national digits (area code + subscriber number) not starting with 3.
 */
export function normalizePkAnyPhone(input: string): string | null {
  const mobile = normalizePkPhone(input);
  if (mobile) return mobile;
  let digits = input.trim().replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('0092')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  let national: string;
  if (digits.startsWith('92')) national = digits.slice(2);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else return null;
  return /^[124-9]\d{8,9}$/.test(national) ? `+92${national}` : null;
}

export function isValidPkPhone(input: string): boolean {
  return normalizePkPhone(input) !== null;
}

/** "+923001234567" → "+92300*****67" for logs and messages. */
export function maskPhone(phone: string): string {
  return phone.length > 8 ? `${phone.slice(0, 6)}*****${phone.slice(-2)}` : '***';
}
