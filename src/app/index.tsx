import React, { useState, useCallback } from 'react';
import { Text, View, StyleSheet, FlatList, Alert } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Screen, Card, SectionLabel, PrimaryButton, StatusPill } from '../../src/components/ui';
import { colors, spacing, typography } from '../../src/theme/theme';
import { koboToNairaString } from '../../src/domain/money';
import { getWalletSnapshot } from '../../src/services/WalletService';
import { getHistory, insertDemoDeposit } from '../../src/db/transactionRepository';
import { useDeviceIdentity } from '../../src/services/useDeviceIdentity';

export default function HomeScreen() {
  const router = useRouter();
  const { deviceId, offlineNairaId } = useDeviceIdentity();
  const [wallet, setWallet] = useState<{ offlineWalletKobo: number; bankBalanceKobo: number } | null>(
    null,
  );
  const [recent, setRecent] = useState<any[]>([]);

  const refreshData = useCallback(() => {
    if (!deviceId) return;
    getWalletSnapshot(deviceId).then(setWallet).catch(() => setWallet(null));
    getHistory(5).then(setRecent).catch(() => setRecent([]));
  }, [deviceId]);

  // Re-runs automatically every time the Home screen comes into focus
  useFocusEffect(
    useCallback(() => {
      refreshData();
    }, [refreshData])
  );

  const handleTestTopUp = async () => {
    try {
      // ₦10,000 = 1,000,000 Kobo
      const testKobo = 1000000;
      await insertDemoDeposit(testKobo, deviceId ?? undefined);
      refreshData();
      Alert.alert('Success', 'Added ₦10,000 demo funds to your wallet!');
    } catch (error) {
      console.error('Failed to add demo funds:', error);
      Alert.alert('Error', 'Could not add demo funds to local database.');
    }
  };

  return (
    <Screen>
      <Text style={styles.greeting}>Offline Naira</Text>
      <Text style={styles.idLabel}>{offlineNairaId ?? 'Not yet provisioned'}</Text>

      <Card style={styles.balanceCard}>
        <SectionLabel>Offline spendable</SectionLabel>
        <Text style={styles.balance}>
          {wallet ? koboToNairaString(wallet.offlineWalletKobo as any) : '—'}
        </Text>
        <Text style={styles.bankBalance}>
          Bank balance: {wallet ? koboToNairaString(wallet.bankBalanceKobo as any) : '—'}
        </Text>
      </Card>

      {/* Developer Demo Top-Up Button */}
      <View style={styles.actionsRow}>
        <PrimaryButton
          label="+ Top Up ₦10,000 (Demo Funds)"
          onPress={handleTestTopUp}
        />
      </View>

      <View style={styles.actionsRow}>
        <PrimaryButton label="Send" onPress={() => router.push('/send')} />
      </View>
      <View style={styles.actionsRow}>
        <PrimaryButton label="Receive" variant="secondary" onPress={() => router.push('/receive')} />
      </View>

      <View style={styles.linkRow}>
        <Text style={styles.link} onPress={() => router.push('/wallet')}>Wallet</Text>
        <Text style={styles.link} onPress={() => router.push('/history')}>History</Text>
        <Text style={styles.link} onPress={() => router.push('/sync')}>Sync</Text>
        <Text style={styles.link} onPress={() => router.push('/settings')}>Settings</Text>
      </View>

      <SectionLabel>Recent activity</SectionLabel>
      <FlatList
        data={recent}
        keyExtractor={(item) => item.tx_id}
        renderItem={({ item }) => (
          <Card style={styles.txRow}>
            <View>
              <Text style={styles.txAmount}>{koboToNairaString(item.amount_kobo)}</Text>
              <Text style={styles.txDirection}>
                {item.direction === 'SENT' ? 'Sent' : 'Received'} · {item.counterparty_device_id}
              </Text>
            </View>
            <StatusPill state={item.state} />
          </Card>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No transactions yet</Text>}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  greeting: { ...typography.h1, color: colors.textPrimary, marginTop: spacing.md },
  idLabel: { ...typography.mono, color: colors.textSecondary, marginBottom: spacing.lg },
  balanceCard: { marginBottom: spacing.lg },
  balance: { ...typography.display, color: colors.textPrimary },
  bankBalance: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  actionsRow: { marginBottom: spacing.sm },
  linkRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  link: { ...typography.body, color: colors.accent },
  txRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
  txAmount: { ...typography.h2, color: colors.textPrimary },
  txDirection: { ...typography.caption, color: colors.textMuted },
  empty: { ...typography.body, color: colors.textMuted, marginTop: spacing.md },
});