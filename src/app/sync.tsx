import React, { useState } from 'react';
import { Text, StyleSheet, Alert } from 'react-native';
import { Screen, Card, SectionLabel, PrimaryButton } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { useDeviceIdentity } from '../services/useDeviceIdentity';
import { runSync } from '../services/SyncService';

export default function SyncScreen() {
  const { deviceId } = useDeviceIdentity();
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const onSync = async () => {
    if (!deviceId) return;
    setBusy(true);
    try {
      const result = await runSync(deviceId);
      setLastResult(
        `Synced ${result.syncedCount} transaction(s). ${result.pendingCount} still pending reconciliation.`,
      );
    } catch (err) {
      Alert.alert('Sync failed', err instanceof Error ? err.message : 'Unknown error');
      setLastResult('Sync failed — will retry next time you have connectivity.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Card>
        <SectionLabel>Offline → online reconciliation</SectionLabel>
        <Text style={styles.body}>
          Uploads every locally COMMITTED transaction to the backend for signature
          re-verification and settlement. Safe to run repeatedly — every request is idempotent
          by transaction ID, so a retried sync never double-applies a transfer.
        </Text>
      </Card>

      <PrimaryButton label="Sync now" onPress={onSync} loading={busy} />

      {lastResult && <Text style={styles.result}>{lastResult}</Text>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.md },
  result: { ...typography.body, color: colors.textPrimary, marginTop: spacing.lg },
});
