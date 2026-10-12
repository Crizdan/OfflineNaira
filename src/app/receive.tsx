import React, { useEffect, useRef, useState } from 'react';
import { Text, StyleSheet, Alert, Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Screen, Card, SectionLabel, PrimaryButton } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { useDeviceIdentity } from '../services/useDeviceIdentity';
import { PaymentEngine } from '../services/PaymentEngine';
import type { BleConnectionState } from '../services/ble/BleService';
import { ble } from '../services/ble/bleInstance';
import { requestBluetoothPermissions } from '../services/blePermissions';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Haptics must never be able to break the payment flow. */
const buzz = (type: Haptics.NotificationFeedbackType) => {
  try {
    Haptics.notificationAsync(type).catch(() => {});
  } catch {
    // haptics unavailable - ignore
  }
};

/** Stop whatever the native side may be running. Safe to call at any time. */
async function resetNative(): Promise<void> {
  await ble.stopAdvertising().catch(() => {});
  await ble.stopGattServer().catch(() => {});
}

// Errors that retrying cannot fix - fail fast and tell the user what to do.
const NON_RETRYABLE = new Set([
  'PERMISSION_DENIED',
  'BLUETOOTH_OFF',
  'BLUETOOTH_UNAVAILABLE',
  'ADVERTISING_UNSUPPORTED',
]);

const errorCode = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;

// Android AdvertiseCallback.ADVERTISE_FAILED_* codes, as reported by the native module.
const ADVERTISE_FAILURES: Record<string, string> = {
  '1': 'the advertisement was too large',
  '2': 'too many advertisers are already running (an earlier receive session did not shut down) - force-close the app and reopen it',
  '3': 'advertising is already running - force-close the app and reopen it',
  '4': 'Android reported an internal Bluetooth error - turn Bluetooth off and on',
  '5': 'this phone does not support BLE advertising',
};

/** Turn any startup failure into something the user can act on, keeping the raw cause. */
function explain(err: unknown): { text: string; permission: boolean } {
  const raw = err instanceof Error ? err.message : String(err);
  const code = errorCode(err);

  if (code === 'PERMISSION_DENIED') {
    return {
      permission: true,
      text: 'Bluetooth permission is missing. Allow "Nearby devices" for this app in Settings, then try again.',
    };
  }
  if (code === 'BLUETOOTH_OFF' || /did not power on/i.test(raw)) {
    return { permission: false, text: 'Bluetooth is off or not ready. Turn it on, then tap Try again.' };
  }
  if (code === 'ADVERTISING_UNSUPPORTED') {
    return { permission: false, text: 'This phone cannot advertise over Bluetooth LE, so it cannot receive payments.' };
  }
  if (code === 'ADVERTISE_FAILED') {
    const n = /error code (\d+)/.exec(raw)?.[1];
    const why = n ? ADVERTISE_FAILURES[n] : undefined;
    return { permission: false, text: `Bluetooth advertising failed${why ? `: ${why}` : ''}. (${raw})` };
  }
  if (code === 'GATT_SERVICE_TIMEOUT' || code === 'GATT_SERVICE_FAILED') {
    return {
      permission: false,
      text: `The Bluetooth server did not start. Turn Bluetooth off and on, then try again. (${raw})`,
    };
  }
  if (/not available in this build|native module/i.test(raw)) {
    return { permission: false, text: `${raw}` };
  }
  return { permission: false, text: `Could not start the receiver: ${raw}` };
}

/**
 * GATT server first, advertising second, so nobody can connect to a server that
 * has no service yet (startGattServer resolves only after the native
 * onServiceAdded callback). Resets leftovers before each attempt, retries
 * transient failures, and re-checks for cancellation after every await so a
 * screen that was left mid-start cannot leave a server or advertiser running.
 * Returns true when running, false if it was cancelled (already cleaned up).
 */
async function startReceiverStack(isCancelled: () => boolean): Promise<boolean> {
  const MAX_ATTEMPTS = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (isCancelled()) return false;
    try {
      await resetNative();
      if (attempt > 1) await sleep(300); // let Android finish tearing the old server down

      await ble.startGattServer();
      if (isCancelled()) {
        await resetNative();
        return false;
      }

      await ble.startAdvertising();
      if (isCancelled()) {
        await resetNative();
        return false;
      }
      return true;
    } catch (err) {
      lastError = err;
      console.warn(`BLE receiver start attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      if (NON_RETRYABLE.has(errorCode(err) ?? '')) break;
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 700);
    }
  }

  await resetNative();
  throw lastError;
}

export default function ReceiveScreen() {
  const router = useRouter();
  const { deviceId, publicKeyB64, offlineNairaId } = useDeviceIdentity();
  const [status, setStatus] = useState<BleConnectionState>('IDLE');
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState('Starting…');
  const [startError, setStartError] = useState<{ text: string; permission: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0); // bump to re-run the startup sequence
  const seenNonces = useRef(new Set<string>()).current;

  useEffect(() => {
    if (!deviceId || !publicKeyB64) return;

    let unsubState: (() => void) | null = null;
    let unsubOffers: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      setReady(false);
      setStartError(null);
      try {
        unsubState = ble.onStateChange(setStatus);
        const engine = new PaymentEngine(ble, deviceId, publicKeyB64);

        // Your permission helper first, then BleService's own check as a
        // backstop: it confirms SCAN + CONNECT + ADVERTISE are ALL granted
        // (returns instantly, no dialog, if they already are). A helper that
        // reports "granted" while ADVERTISE is missing is what makes the
        // native startAdvertising reject later.
        setPhase('Checking permissions…');
        const granted =
          (await requestBluetoothPermissions().catch(() => false)) &&
          (await ble.requestPermissions().catch(() => false));
        if (cancelled) return;
        if (!granted) {
          setStartError({
            permission: true,
            text: 'Bluetooth permissions are required to receive offline payments. Allow "Nearby devices" in Settings, then try again.',
          });
          return;
        }

        // Longer than the 5s default: the user may be flipping Bluetooth on
        // from the notification shade while this screen waits.
        setPhase('Waiting for Bluetooth…');
        await ble.waitForPoweredOn(15_000);
        if (cancelled) return;

        setPhase('Starting receiver…');
        const running = await startReceiverStack(() => cancelled);
        if (!running) return;

        unsubOffers = ble.subscribeToOffers((bytes) => {
          engine
            .handleIncomingOffer(bytes, seenNonces)
            .then((result: unknown) => {
              // Works whether handleIncomingOffer returns void or an
              // { accepted, reason } result.
              const r = result as { accepted?: boolean; reason?: string } | undefined;
              if (r && r.accepted === false) {
                buzz(Haptics.NotificationFeedbackType.Error);
                Alert.alert('Payment rejected', r.reason ?? 'The offer failed validation.');
                return;
              }
              buzz(Haptics.NotificationFeedbackType.Success);
              setTimeout(() => {
                if (!cancelled) router.replace('/wallet');
              }, 1500);
            })
            .catch((err) => {
              buzz(Haptics.NotificationFeedbackType.Error);
              Alert.alert(
                'Failed to process incoming payment',
                err instanceof Error ? err.message : 'Unknown error',
              );
            });
        });

        setReady(true);
        setPhase('Waiting for a sender');
      } catch (err) {
        console.warn('BLE receiver start failed:', err);
        if (!cancelled) setStartError(explain(err));
      }
    })();

    return () => {
      cancelled = true;
      unsubState?.();
      unsubOffers?.();
      // If a start is still in flight, startReceiverStack sees `cancelled`
      // after its next await and cleans up what it started.
      resetNative();
    };
  }, [deviceId, publicKeyB64, attempt]);

  const statusText: Record<BleConnectionState, string> = {
    IDLE: 'Not started',
    REQUESTING_PERMISSIONS: 'Requesting Bluetooth permissions…',
    SCANNING: 'Scanning',
    CONNECTING: 'Connecting',
    DISCOVERING: 'Discovering',
    CONNECTED: 'Connected — a sender is talking to this device',
    ADVERTISING: 'Advertising — nearby senders can find this device',
    DISCONNECTED: ready ? 'Advertising — waiting for a sender' : 'Stopped',
    ERROR: 'Bluetooth error — see console',
  };

  return (
    <Screen>
      <Card style={styles.idCard}>
        <SectionLabel>Your Offline Naira ID</SectionLabel>
        <Text style={styles.id}>{offlineNairaId ?? 'Provisioning…'}</Text>
        <Text style={styles.deviceId}>{deviceId}</Text>
      </Card>

      <Card>
        <SectionLabel>Bluetooth status</SectionLabel>
        {startError ? (
          <>
            <Text style={styles.error}>{startError.text}</Text>
            <View style={styles.buttons}>
              <PrimaryButton label="Try again" onPress={() => setAttempt((a) => a + 1)} />
              {startError.permission && (
                <View style={styles.second}>
                  <PrimaryButton
                    label="Open Settings"
                    variant="secondary"
                    onPress={() => Linking.openSettings()}
                  />
                </View>
              )}
            </View>
          </>
        ) : (
          <Text style={styles.status}>{ready ? statusText[status] : phase}</Text>
        )}
      </Card>

      <Text style={styles.note}>
        This device is advertising and running a GATT server via the native BlePeripheral module.
        Share your Offline Naira ID with the sender, or let their device discover you directly over Bluetooth.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  idCard: { marginBottom: spacing.md, alignItems: 'center', paddingVertical: spacing.xl },
  id: { ...typography.display, color: colors.accent, letterSpacing: 2 },
  deviceId: { ...typography.mono, color: colors.textMuted, marginTop: spacing.sm },
  status: { ...typography.body, color: colors.textSecondary },
  error: { ...typography.body, color: colors.danger, marginBottom: spacing.md },
  buttons: { marginTop: spacing.xs },
  second: { marginTop: spacing.sm },
  note: { ...typography.caption, color: colors.textMuted, marginTop: spacing.lg },
});
