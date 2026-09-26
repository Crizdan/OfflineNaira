import React, { useEffect, useState } from 'react';
import { Text, View, FlatList, StyleSheet } from 'react-native';
import { Screen, Card, StatusPill } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { koboToNairaString } from '../domain/money';
import { getHistory } from '../db/transactionRepository';

export default function HistoryScreen() {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    getHistory(100).then(setItems).catch(() => setItems([]));
  }, []);

  return (
    <Screen>
      <FlatList
        data={items}
        keyExtractor={(item) => item.tx_id}
        renderItem={({ item }) => (
          <Card style={styles.row}>
            <View style={styles.left}>
              <Text style={styles.amount}>{koboToNairaString(item.amount_kobo)}</Text>
              <Text style={styles.meta}>
                {item.direction === 'SENT' ? 'To' : 'From'} {item.counterparty_device_id}
              </Text>
              <Text style={styles.meta}>{new Date(item.created_at).toLocaleString()}</Text>
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
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
  left: { flex: 1 },
  amount: { ...typography.h2, color: colors.textPrimary },
  meta: { ...typography.caption, color: colors.textMuted },
  empty: { ...typography.body, color: colors.textMuted },
});
