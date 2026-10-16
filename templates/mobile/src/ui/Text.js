import { StyleSheet, Text } from 'react-native';
import { theme } from '../theme.js';

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  h1: { fontFamily: f.display, fontSize: 34, lineHeight: 40, fontWeight: f.display ? undefined : '800', color: c.fg, letterSpacing: -0.5 },
  h2: { fontFamily: f.display, fontSize: 24, lineHeight: 30, fontWeight: f.display ? undefined : '700', color: c.fg, letterSpacing: -0.3 },
  h3: { fontFamily: f.bodySemibold, fontSize: 18, lineHeight: 24, fontWeight: f.bodySemibold ? undefined : '600', color: c.fg },
  body: { fontFamily: f.body, fontSize: 16, lineHeight: 24, color: c.fg },
  muted: { fontFamily: f.body, fontSize: 14, lineHeight: 20, color: c.muted },
  label: { fontFamily: f.bodyMedium, fontSize: 13, lineHeight: 18, fontWeight: f.bodyMedium ? undefined : '500', color: c.fg },
  eyebrow: { fontFamily: f.bodySemibold, fontSize: 12, letterSpacing: 1.6, textTransform: 'uppercase', color: c.primary[600], fontWeight: f.bodySemibold ? undefined : '600' },
});

const make = (style) => {
  function T({ style: extra, ...props }) {
    return <Text style={[style, extra]} {...props} />;
  }
  return T;
};

export const H1 = make(styles.h1);
export const H2 = make(styles.h2);
export const H3 = make(styles.h3);
export const Body = make(styles.body);
export const Muted = make(styles.muted);
export const Label = make(styles.label);
export const Eyebrow = make(styles.eyebrow);
export const textStyles = styles;
