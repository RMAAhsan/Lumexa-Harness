import { Pressable, StyleSheet, View } from 'react-native';
import { theme } from '../theme.js';

/** Surface container. Pass onPress to make it tappable. padded={false} for edge-to-edge images. */
export function Card({ children, onPress, padded = true, style }) {
  const content = [styles.card, padded && styles.padded, style];
  if (!onPress) return <View style={content}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [...content, pressed && styles.pressed]}>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius + 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
    overflow: 'hidden',
    shadowColor: '#0f172a',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
  },
  padded: { padding: 18 },
  pressed: { opacity: 0.92, transform: [{ scale: 0.99 }] },
});
