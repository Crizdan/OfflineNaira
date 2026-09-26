/**
 * All money in this codebase is an integer number of kobo (1 NGN = 100 kobo).
 * NEVER represent money as a float/number with decimals anywhere: not in the
 * DB, not in a signed payload, not in UI state. This module is the only
 * place allowed to convert to/from a display string.
 */

export type Kobo = number & { readonly __brand: 'Kobo' };

export function kobo(value: number): Kobo {
  if (!Number.isInteger(value)) {
    throw new Error(`Kobo amount must be an integer, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`Kobo amount must be non-negative, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Kobo amount exceeds safe integer range: ${value}`);
  }
  return value as Kobo;
}

export function nairaToKobo(naira: string): Kobo {
  // Parse from a decimal string ("1000.50") to avoid float rounding.
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(naira.trim());
  if (!match) {
    throw new Error(`Invalid Naira amount: "${naira}"`);
  }
  const whole = BigInt(match[1]);
  const frac = (match[2] ?? '').padEnd(2, '0');
  const total = whole * 100n + BigInt(frac);
  return kobo(Number(total));
}

export function koboToNairaString(amount: Kobo): string {
  const whole = Math.floor(amount / 100);
  const frac = amount % 100;
  return `₦${whole.toLocaleString('en-NG')}.${frac.toString().padStart(2, '0')}`;
}

export function addKobo(a: Kobo, b: Kobo): Kobo {
  return kobo(a + b);
}

export function subKobo(a: Kobo, b: Kobo): Kobo {
  if (b > a) throw new Error('Insufficient amount: subtraction would go negative');
  return kobo(a - b);
}

export function isPositive(a: Kobo): boolean {
  return a > 0;
}
