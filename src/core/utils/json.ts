/**
 * JSON replacer installed on Express (`app.set('json replacer', jsonReplacer)`), so
 * every response serialises BigInt (money in paisa) as a decimal string and no
 * precision is lost in JavaScript clients: 400000n → "400000".
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
