import React from 'react';
import { View, Text, Pressable, StyleSheet, ViewStyle, ActivityIndicator } from 'react-native';
import { colors, spacing, radii, typography } from '../theme/theme';

export const Screen: React.FC<{ children: React.ReactNode; style?: ViewStyle }> = ({
  children,
  style,
}) => <View style={[styles.screen, style]}>{children}</View>;

export const Card: React.FC<{ children: React.ReactNode; style?: ViewStyle }> = ({
  children,
  style,
}) => <View style={[styles.card, style]}>{children}</View>;

export const SectionLabel: React.FC<{ children: string }> = ({ children }) => (
  <Text style={styles.sectionLabel}>{children}</Text>
);

export const PrimaryButton: React.FC<{
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}> = ({ label, onPress, disabled, loading, variant = 'primary' }) => (
  <Pressable
    onPress={onPress}
    disabled={disabled || loading}
    style={({ pressed }) => [
      styles.button,
      variant === 'secondary' && styles.buttonSecondary,
      variant === 'danger' && styles.buttonDanger,
      (disabled || loading) && styles.buttonDisabled,
      pressed && styles.buttonPressed,
    ]}
  >
    {loading ? (
      <ActivityIndicator color={colors.bgPrimary} />
    ) : (
      <Text
        style={[
          styles.buttonLabel,
          variant === 'secondary' && styles.buttonLabelSecondary,
        ]}
      >
        {label}
      </Text>
    )}
  </Pressable>
);

const STATE_COLORS: Record<string, string> = {
  SETTLED: colors.success,
  CONFIRMED: colors.success,
  COMMITTED: colors.info,
  ACCEPTED: colors.info,
  PENDING_RECONCILIATION: colors.warning,
  OFFERED: colors.warning,
  RECEIVED: colors.warning,
  VALIDATED: colors.warning,
  SIGNED: colors.textSecondary,
  CREATED: colors.textSecondary,
  FAILED: colors.danger,
  REJECTED: colors.danger,
  TIMEOUT: colors.danger,
};

export const StatusPill: React.FC<{ state: string }> = ({ state }) => (
  <View style={[styles.pill, { borderColor: STATE_COLORS[state] ?? colors.textMuted }]}>
    <Text style={[styles.pillText, { color: STATE_COLORS[state] ?? colors.textMuted }]}>
      {state.replace(/_/g, ' ')}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgPrimary, padding: spacing.md },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  sectionLabel: {
    ...typography.caption,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonDanger: { backgroundColor: colors.danger },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.85 },
  buttonLabel: { ...typography.h2, color: colors.bgPrimary },
  buttonLabelSecondary: { color: colors.textPrimary },
  pill: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  pillText: { ...typography.caption, fontWeight: '600' },
});
