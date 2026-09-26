import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../theme/theme';

// This file is the Expo Router equivalent of the old App.tsx / RootNavigator.
// Expo Router owns the app's entry point (see index.ts + package.json
// "main": "expo-router/entry") — this _layout.tsx is what previously would
// have been your top-level <NavigationContainer><Stack.Navigator>...
//
// Note: as of Expo Router SDK 56+, importing from @react-navigation/*
// packages directly in app code is no longer supported — use expo-router's
// own exports (Stack, Link, useRouter, etc.) instead, as done here.
export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
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
    </>
  );
}
