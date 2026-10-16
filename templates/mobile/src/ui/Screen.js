import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { theme } from '../theme.js';

/** Every screen's wrapper: safe area + scrolling + standard padding. scroll={false} for lists that scroll themselves. */
export function Screen({ children, scroll = true, padded = true, edges = ['top'], refreshControl, style }) {
  const body = [padded && styles.padded, style];
  return (
    <SafeAreaView edges={edges} style={styles.safe}>
      {scroll ? (
        <ScrollView contentContainerStyle={[body, styles.grow]} refreshControl={refreshControl} showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.grow, body]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

/** Vertical stack with a gap: <Stack gap={12}>…</Stack>. Row: horizontal. */
export const Stack = ({ gap = 12, style, children }) => <View style={[{ gap }, style]}>{children}</View>;
export const Row = ({ gap = 10, style, children }) => <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.canvas },
  padded: { padding: 20, paddingBottom: 40 },
  grow: { flexGrow: 1 },
});
