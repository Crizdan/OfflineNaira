import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet, FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen, Card, SectionLabel, PrimaryButton, StatusPill } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { koboToNairaString } from '../domain/money';
import { getWalletSnapshot } from '../services/WalletService';
import { getHistory } from '../db/transactionRepository';
import { useDeviceIdentity } from '../services/useDeviceIdentity';

export default function HomeScreen() {
  const router = useRouter();
  const { deviceId, offlineNairaId } = useDeviceIdentity();
  const [wallet, setWallet] = useState<{ offlineWalletKobo: number; bankBalanceKobo: number } | null>(
    null,
  );
  const [recent, setRecent] = useState<any[]>([]);

  useEffect(() => {
    if (!deviceId) return;
    getWalletSnapshot(deviceId).then(setWallet).catch(() => setWallet(null));
    getHistory(5).then(setRecent).catch(() => setRecent([]));
  }, [deviceId]);

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
