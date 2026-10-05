import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors, spacing, typography } from '../theme/theme';
import { AppProvisioningProvider, useProvisioning } from '../services/AppProvisioning';
import { PrimaryButton } from '../components/ui';
import { AuthGate } from '../components/AuthGate';

// This file is the Expo Router equivalent of the old App.tsx / RootNavigator.
// Expo Router owns the app's entry point (see index.ts, loaded via
// package.json's "main": "./index.ts" — NOT "expo-router/entry" directly,
// since index.ts loads the crypto polyfill first; pointing "main" straight
// at expo-router/entry was the actual root cause of identity/wallet
// provisioning silently failing on fresh installs) — this _layout.tsx is
// what previously would have been your top-level
// <NavigationContainer><Stack.Navigator>...
//
// Note: as of Expo Router SDK 56+, importing from @react-navigation/*
// packages directly in app code is no longer supported — use expo-router's
// own exports (Stack, Link, useRouter, etc.) instead, as done here.
export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <AppProvisioningProvider>
        <ProvisioningGate>
          <AuthGate>
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.bgSurface },
                headerTintColor: colors.textPrimary,
                contentStyle: { backgroundColor: colors.bgPrimary },
              }}
            >
              <Stack.Screen name="index" options={{ title: 'Offline Naira' }} />
              <Stack.Screen name="wallet" options={{ title: 'Wallet' }} />
              <Stack.Screen name="send" options={{ title: 'Send' }} />
              <Stack.Screen name="receive" options={{ title: 'Receive' }} />
              <Stack.Screen name="history" options={{ title: 'History' }} />
              <Stack.Screen name="settings" options={{ title: 'Settings' }} />
              <Stack.Screen name="sync" options={{ title: 'Sync' }} />
            </Stack>
          </AuthGate>
        </ProvisioningGate>
      </AppProvisioningProvider>
    </>
  );
}

/**
* Blocks the whole app behind identity/wallet setup completing — no screen
* ever mounts with a null deviceId while setup is silently still running
* (the previous failure mode). A real failure shows an error and a retry
* button instead of an infinite "Loading wallet…"/"Not yet provisioned".
*/
function ProvisioningGate({ children }: { children: React.ReactNode }) {
  const { status, error, retry } = useProvisioning();

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.message}>Setting up your Offline Naira wallet…</Text>
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Setup failed</Text>
        <Text style={styles.message}>{error ?? 'Unknown error'}</Text>
        <View style={styles.retryButton}>
          <PrimaryButton label="Try again" onPress={retry} />
        </View>
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  message: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  errorTitle: {
    ...typography.h1,
    color: colors.danger,
    marginBottom: spacing.sm,
  },
  retryButton: {
    marginTop: spacing.lg,
    alignSelf: 'stretch',
  },
});