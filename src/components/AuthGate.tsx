/**
 * AuthGate.tsx
 *
 * Wraps the app's screens. It renders one of:
 *   - setup:  no account on this device yet -> username, password, 4-6 digit PIN
 *   - login:  account exists -> biometric prompt straight away (if available),
 *             with a password form as the fallback
 *   - the children (your existing Stack) once unlocked
 *
 * It is a pure wrapper: it does not import the wallet, BLE or database layers.
 * Failures surface as an error screen with a retry button, not a blank screen.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { PrimaryButton } from './ui';
import { colors, spacing, radii, typography } from '../theme/theme';
import * as authService from '../services/authService';

type GateState = 'checking' | 'setup' | 'login' | 'unlocked' | 'error';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('checking');
  const [fatal, setFatal] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  // Guards the automatic on-launch prompt so React re-renders can't fire it twice.
  const autoPrompted = useRef(false);

  const tryBiometrics = useCallback(async () => {
    const ok = await authService.authenticateWithBiometrics('Unlock Offline Naira');
    if (ok) setState('unlocked');
  }, []);

  const init = useCallback(async () => {
    setState('checking');
    setFatal(null);
    try {
      if (!(await authService.hasAccount())) {
        setState('setup');
        return;
      }
      setUsername(await authService.getUsername());
      const bio = await authService.isBiometricAvailable();
      setBioAvailable(bio);
      setState('login');
      if (bio && !autoPrompted.current) {
        autoPrompted.current = true;
        await tryBiometrics();
      }
    } catch (err) {
      setFatal(err instanceof Error ? err.message : 'Could not read your account.');
      setState('error');
    }
  }, [tryBiometrics]);

  useEffect(() => {
    init();
  }, [init]);

  if (state === 'unlocked') return <>{children}</>;

  if (state === 'checking') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Could not start</Text>
        <Text style={styles.body}>{fatal}</Text>
        <View style={styles.full}>
          <PrimaryButton label="Try again" onPress={init} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        style={styles.flex}
      >
        {state === 'setup' ? (
          <SetupForm onDone={() => setState('unlocked')} />
        ) : (
          <LoginForm
            username={username}
            bioAvailable={bioAvailable}
            onBiometrics={tryBiometrics}
            onUnlocked={() => setState('unlocked')}
          />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ------------------------------------------------------------------ setup

function SetupForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (password !== confirmPassword) return setError('Passwords do not match.');
    if (pin !== confirmPin) return setError('PINs do not match.');
    setBusy(true);
    try {
      await authService.setupUserAccount(username, password, pin);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your account.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Text style={styles.title}>Create your account</Text>
      <Text style={styles.body}>
        Your password unlocks the app. Your transaction PIN approves payments when biometrics are
        unavailable. Neither is ever stored in plain text.
      </Text>

      <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" />
      <Field label="Password (8+ characters)" value={password} onChangeText={setPassword} secure />
      <Field
        label="Confirm password"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        secure
      />
      <Field
        label="Transaction PIN (4-6 digits)"
        value={pin}
        onChangeText={(t: string) => setPin(t.replace(/\D/g, ''))}
        secure
        numeric
      />
      <Field
        label="Confirm PIN"
        value={confirmPin}
        onChangeText={(t: string) => setConfirmPin(t.replace(/\D/g, ''))}
        secure
        numeric
      />

      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton
        label={busy ? 'Securing your account...' : 'Create account'}
        onPress={submit}
        loading={busy}
        disabled={busy || !username || !password || !pin}
      />
    </View>
  );
}

// ------------------------------------------------------------------ login

function LoginForm({
  username,
  bioAvailable,
  onBiometrics,
  onUnlocked,
}: {
  username: string | null;
  bioAvailable: boolean;
  onBiometrics: () => void;
  onUnlocked: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (await authService.authenticateWithPassword(password)) {
        onUnlocked();
        return;
      }
      const waitMs = await authService.getLockoutRemainingMs('password');
      setError(
        waitMs > 0
          ? `Too many attempts. Try again in ${Math.ceil(waitMs / 1000)}s.`
          : 'Incorrect password.',
      );
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify your password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Text style={styles.title}>{username ? `Welcome back, ${username}` : 'Welcome back'}</Text>
      <Field label="Password" value={password} onChangeText={setPassword} secure />
      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton
        label="Unlock"
        onPress={submit}
        loading={busy}
        disabled={busy || !password}
      />
      {bioAvailable && (
        <View style={styles.secondary}>
          <PrimaryButton label="Use biometrics" variant="secondary" onPress={onBiometrics} />
        </View>
      )}
    </View>
  );
}

// ------------------------------------------------------------------ field

function Field({
  label,
  value,
  onChangeText,
  secure,
  numeric,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  secure?: boolean;
  numeric?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        keyboardType={numeric ? 'number-pad' : 'default'}
        maxLength={numeric ? 6 : undefined}
        autoCapitalize={autoCapitalize ?? 'none'}
        autoCorrect={false}
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg, paddingTop: spacing.xxl, flexGrow: 1 },
  center: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  full: { alignSelf: 'stretch', marginTop: spacing.lg },
  title: { ...typography.h1, color: colors.textPrimary, marginBottom: spacing.sm },
  body: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.lg },
  errorTitle: { ...typography.h1, color: colors.danger, marginBottom: spacing.sm },
  error: { ...typography.body, color: colors.danger, marginBottom: spacing.md },
  field: { marginBottom: spacing.md },
  label: { ...typography.caption, color: colors.textMuted, marginBottom: spacing.xs },
  input: {
    ...typography.body,
    color: colors.textPrimary,
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  secondary: { marginTop: spacing.md },
});
