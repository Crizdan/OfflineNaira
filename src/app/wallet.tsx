import React, { useCallback, useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen, Card, SectionLabel, PrimaryButton } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { koboToNairaString } from '../domain/money';
import { getWalletSnapshot, OFFLINE_LIMITS } from '../services/WalletService';
import { useDeviceIdentity } from '../services/useDeviceIdentity';
import { requestBluetoothPermissions } from '../services/blePermissions';
import MockBankModal from '../components/MockBankModal';

export default function WalletScreen() {
  const { deviceId } = useDeviceIdentity();
  const [wallet, setWallet] = useState<Awaited<ReturnType<typeof getWalletSnapshot>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMockModalVisible, setIsMockModalVisible] = useState(false);

  const load = useCallback(() => {
    if (!deviceId) return;
    setError(null);
    getWalletSnapshot(deviceId)
      .then(setWallet)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load wallet'));
  }, [deviceId]);

  // Request Bluetooth and Location permissions automatically on app startup
  useEffect(() => {
    requestBluetoothPermissions();
  }, []);

  // Re-runs automatically every time the Wallet screen comes into focus
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (error) {
    return (
      <Screen>
        <Text style={styles.errorText}>{error}</Text>
        <PrimaryButton label="Try again" onPress={load} />
      </Screen>
    );
  }

  if (!wallet) {
    return (
      <Screen>
        <Text style={styles.empty}>Loading wallet…</Text>
      </Screen>
    );
  }

  const rows: [string, string][] = [
    ['Bank balance (last synced)', koboToNairaString(wallet.bankBalanceKobo)],
    ['Offline spendable', koboToNairaString(wallet.offlineWalletKobo)],
    ['Reserved (in-flight sends)', koboToNairaString(wallet.reservedKobo)],
    ['Sent today', koboToNairaString(wallet.dailySentKobo)],
    ['Received today', koboToNairaString(wallet.dailyReceivedKobo)],
  ];

  return (
    <Screen>
      {/* Mock Bank Top Up Button wrapped in a View */}
      <View style={styles.topUpContainer}>
        <PrimaryButton
          label="+ Top Up ₦10,000 (Demo Funds)"
          onPress={() => setIsMockModalVisible(true)}
        />
      </View>

      <Card>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={styles.rowValue}>{value}</Text>
          </View>
        ))}
      </Card>

      <SectionLabel>Offline limits</SectionLabel>
      <Card>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Per-transaction cap</Text>
          <Text style={styles.rowValue}>{koboToNairaString(OFFLINE_LIMITS.maxSingleSendKobo)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Daily send cap</Text>
          <Text style={styles.rowValue}>{koboToNairaString(OFFLINE_LIMITS.maxDailySendKobo)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Daily receive cap</Text>
          <Text style={styles.rowValue}>{koboToNairaString(OFFLINE_LIMITS.maxDailyReceiveKobo)}</Text>
        </View>
      </Card>
      <Text style={styles.note}>
        These caps bound offline risk until the next sync. Balances shown here are the device's
        local view — the backend ledger is the source of truth.
      </Text>

      {/* Mock Bank Deposit Modal */}
      <MockBankModal
        visible={isMockModalVisible}
        onClose={() => setIsMockModalVisible(false)}
        onSuccess={() => {
          load(); // Refresh wallet snapshot after successful mock deposit
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  topUpContainer: {
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLabel: { ...typography.body, color: colors.textSecondary },
  rowValue: { ...typography.body, color: colors.textPrimary, fontWeight: '600' },
  note: { ...typography.caption, color: colors.textMuted, marginTop: spacing.md },
  empty: { ...typography.body, color: colors.textMuted },
  errorText: { ...typography.body, color: colors.danger, marginBottom: spacing.md },
});