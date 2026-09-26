export const colors = {
  bgPrimary: '#0B0E14',
  bgSurface: '#141821',
  bgElevated: '#1B2130',
  border: '#252C3D',
  textPrimary: '#F4F6FA',
  textSecondary: '#8C93A6',
  textMuted: '#5B6273',
  accent: '#22D3A6', // Naira-green accent
  accentMuted: '#123B31',
  warning: '#F5A524',
  danger: '#F5555A',
  success: '#22D3A6',
  info: '#5B8DEF',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radii = {
  sm: 8,
  md: 14,
  lg: 20,
  pill: 999,
};

export const typography = {
  display: { fontSize: 34, fontWeight: '700' as const, letterSpacing: -0.5 },
  h1: { fontSize: 24, fontWeight: '700' as const },
  h2: { fontSize: 18, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  mono: { fontSize: 14, fontFamily: 'monospace' as const },
};

export const theme = { colors, spacing, radii, typography };
export type Theme = typeof theme;
