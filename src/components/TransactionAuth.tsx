/**
 * TransactionAuth.tsx
 *
 * useTransactionAuthorization() gives a screen:
 *   authorize(reason) -> Promise<boolean>
 *       1. tries the OS biometric prompt
 *       2. if that is unavailable, cancelled or fails -> shows the PIN modal
 *       resolves true only if biometrics matched or the PIN was correct
 *   pinPrompt -> a <Modal> element to render once anywhere in the screen
 *
 * It wraps authService only. It does not know about BLE, the wallet or the
 * payment engine, so it can guard any action, not just Send.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, StyleSheet } from 'react-native';
import { PrimaryButton } from './ui';
import { colors, spacing, radii, typography } from '../theme/theme';
import * as authService from '../services/authService';

export function PinPromptModal({
  visible,
  onSuccess,
  onCancel,
}: {
  visible: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fresh state every time the modal opens; show an existing lockout right away.
  useEffect(() => {
    if (!visible) return;
    setPin('');
    setError(null);
    authService
      .getLockoutRemainingMs('pin')
      .then((ms) => {
        if (ms > 0) setError(`Too many attempts. Try again in ${Math.ceil(ms / 1000)}s.`);
      })
      .catch(() => {});
  }, [visible]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (await authService.authenticateWithPin(pin)) {
        setPin('');
        onSuccess();
        return;
      }
      const ms = await authService.getLockoutRemainingMs('pin');
      setError(
        ms > 0
          ? `Too many attempts. Try again in ${Math.ceil(ms / 1000)}s.`
          : 'Incorrect PIN.',
      );
      setPin('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify your PIN.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>Enter transaction PIN</Text>
          <Text style={styles.body}>Confirm this payment with your PIN.</Text>
          <TextInput
            value={pin}
            onChangeText={(t: string) => setPin(t.replace(/\D/g, ''))}
            secureTextEntry
            keyboardType="number-pad"
            maxLength={6}
            autoFocus
            style={styles.input}
            placeholder="PIN"
            placeholderTextColor={colors.textMuted}
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <PrimaryButton
            label="Authorize"
            onPress={submit}
            loading={busy}
            disabled={busy || pin.length < 4}
          />
          <View style={styles.cancel}>
            <PrimaryButton label="Cancel" variant="secondary" onPress={onCancel} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function useTransactionAuthorization() {
  const [pinVisible, setPinVisible] = useState(false);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    setPinVisible(false);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(ok);
  }, []);

  // If the screen unmounts mid-prompt, don't leave authorize() hanging forever.
  useEffect(
    () => () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    },
    [],
  );

  const authorize = useCallback(async (reason: string): Promise<boolean> => {
    if (resolverRef.current) return false; // a prompt is already open

    if (await authService.authenticateWithBiometrics(reason)) return true;

    // Biometrics unavailable / cancelled / failed -> PIN fallback.
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setPinVisible(true);
    });
  }, []);

  const pinPrompt = (
    <PinPromptModal
      visible={pinVisible}
      onSuccess={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { authorize, pinPrompt };
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    alignSelf: 'stretch',
    backgroundColor: colors.bgSurface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  title: { ...typography.h2, color: colors.textPrimary, marginBottom: spacing.xs },
  body: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.md },
  input: {
    ...typography.h1,
    color: colors.textPrimary,
    textAlign: 'center',
    letterSpacing: 8,
    backgroundColor: colors.bgPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: 12,
    marginBottom: spacing.md,
  },
  error: { ...typography.body, color: colors.danger, marginBottom: spacing.md },
  cancel: { marginTop: spacing.sm },
});
