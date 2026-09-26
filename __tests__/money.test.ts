import { kobo, nairaToKobo, koboToNairaString, addKobo, subKobo } from '../src/domain/money';

describe('money', () => {
  it('parses Naira strings to kobo without float error', () => {
    expect(nairaToKobo('1000')).toBe(100000);
    expect(nairaToKobo('1000.50')).toBe(100050);
    expect(nairaToKobo('0.01')).toBe(1);
  });

  it('rejects non-integer kobo', () => {
    expect(() => kobo(10.5)).toThrow();
  });

  it('rejects negative kobo', () => {
    expect(() => kobo(-1)).toThrow();
  });

  it('formats kobo back to a Naira display string', () => {
    expect(koboToNairaString(kobo(100050))).toBe('₦1,000.50');
    expect(koboToNairaString(kobo(1))).toBe('₦0.01');
  });

  it('add/sub never goes below zero', () => {
    expect(addKobo(kobo(100), kobo(50))).toBe(150);
    expect(() => subKobo(kobo(50), kobo(100))).toThrow();
  });
});
