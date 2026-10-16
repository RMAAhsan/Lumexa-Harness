import { CheckCircle2, XCircle } from 'lucide-react-native';
import { createContext, useCallback, useContext, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme.js';

const ToastContext = createContext(() => {});

/** const toast = useToast(); toast('Booked!'); toast('Could not save', 'error'); */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const push = useCallback((message, tone = 'success') => {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      {toast ? (
        <View pointerEvents="none" style={styles.wrap}>
          <View style={styles.toast}>
            {toast.tone === 'error' ? <XCircle size={20} color={theme.colors.danger} /> : <CheckCircle2 size={20} color={theme.colors.success} />}
            <Text style={styles.text}>{toast.message}</Text>
          </View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, bottom: 100, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: theme.colors.surface, borderRadius: theme.radius, paddingHorizontal: 16, paddingVertical: 12, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 16, elevation: 6 },
  text: { color: theme.colors.fg, fontSize: 15, fontFamily: theme.fonts.bodyMedium },
});
