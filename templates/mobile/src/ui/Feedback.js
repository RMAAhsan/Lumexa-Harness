import { Inbox } from 'lucide-react-native';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme.js';
import { Body, H3, Muted } from './Text.js';

const c = theme.colors;

export function Spinner({ label = 'Loading…' }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={c.primary[600]} />
      <Muted>{label}</Muted>
    </View>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }) {
  return (
    <View style={styles.empty}>
      <View style={styles.iconWrap}>
        <Icon size={24} color={c.primary[600]} />
      </View>
      <H3 style={styles.centerText}>{title}</H3>
      {description ? <Muted style={styles.centerText}>{description}</Muted> : null}
      {action ? <View style={{ marginTop: 12 }}>{action}</View> : null}
    </View>
  );
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <View style={styles.error}>
      <Body style={{ color: c.danger, fontSize: 14 }}>{children}</Body>
    </View>
  );
}

const TONES = {
  neutral: [c.ink[100], c.ink[700]],
  primary: [c.primary[50], c.primary[700]],
  accent: [c.accent[50], c.accent[700]],
  success: ['#ecfdf5', '#047857'],
  warning: ['#fffbeb', '#b45309'],
  danger: ['#fef2f2', '#b91c1c'],
};

export function Badge({ tone = 'neutral', children }) {
  const [bg, fg] = TONES[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '600', fontFamily: theme.fonts.bodySemibold }}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 10 },
  centerText: { textAlign: 'center' },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24, gap: 6, borderRadius: theme.radius + 4, borderWidth: 1, borderStyle: 'dashed', borderColor: c.line },
  iconWrap: { backgroundColor: c.primary[50], borderRadius: 999, padding: 12, marginBottom: 6 },
  error: { backgroundColor: '#fef2f2', borderColor: '#fecaca', borderWidth: 1, borderRadius: theme.radius, padding: 12 },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
});
