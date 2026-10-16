import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme.js';

const c = theme.colors;
const VARIANTS = {
  primary: { bg: c.primary[600], pressed: c.primary[700], fg: c.onPrimary, border: c.primary[600] },
  secondary: { bg: c.surface, pressed: c.ink[100], fg: c.fg, border: c.line },
  ghost: { bg: 'transparent', pressed: c.ink[100], fg: c.primary[700], border: 'transparent' },
  danger: { bg: c.danger, pressed: '#b91c1c', fg: '#ffffff', border: c.danger },
};
const SIZES = { sm: { h: 38, px: 14, fs: 14 }, md: { h: 48, px: 18, fs: 15 }, lg: { h: 56, px: 24, fs: 17 } };

/** <Button onPress={save} loading={saving} icon={Plus} variant="secondary" size="lg" block>Save</Button> */
export function Button({ children, onPress, variant = 'primary', size = 'md', icon: Icon, loading, disabled, block, style }) {
  const v = VARIANTS[variant];
  const s = SIZES[size];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.base,
        { height: s.h, paddingHorizontal: s.px, backgroundColor: pressed ? v.pressed : v.bg, borderColor: v.border },
        variant === 'primary' && styles.glow,
        block && styles.block,
        (disabled || loading) && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? <ActivityIndicator color={v.fg} size="small" /> : Icon ? <Icon size={18} color={v.fg} /> : null}
        {typeof children === 'string' ? (
          <Text style={[styles.text, { color: v.fg, fontSize: s.fs, fontFamily: theme.fonts.bodySemibold }]}>{children}</Text>
        ) : (
          children
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: theme.radius, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  text: { fontWeight: '600' },
  block: { alignSelf: 'stretch' },
  disabled: { opacity: 0.55 },
  pressed: { transform: [{ scale: 0.98 }] },
  glow: { shadowColor: c.primary[600], shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 4 },
});
