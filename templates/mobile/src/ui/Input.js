import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { theme } from '../theme.js';
import { textStyles } from './Text.js';

/** <Input label="Email" value={email} onChangeText={setEmail} error={err} keyboardType="email-address" /> */
export function Input({ label, error, hint, style, ...props }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.wrap, style]}>
      {label ? <Text style={textStyles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={theme.colors.muted}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.input, focused && styles.focused, error && styles.errorBorder, props.multiline && styles.multiline]}
        {...props}
      />
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={textStyles.muted}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  input: {
    minHeight: 48,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.colors.line,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 14,
    fontSize: 16,
    fontFamily: theme.fonts.body,
    color: theme.colors.fg,
  },
  multiline: { minHeight: 110, paddingTop: 12, textAlignVertical: 'top' },
  focused: { borderColor: theme.colors.primary[500] },
  errorBorder: { borderColor: theme.colors.danger },
  error: { color: theme.colors.danger, fontSize: 13 },
});
