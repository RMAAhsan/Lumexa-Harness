/** Auth token storage: SecureStore on iOS/Android, localStorage on web. */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'token';

export async function getToken() {
  if (Platform.OS === 'web') return globalThis.localStorage?.getItem(KEY) ?? null;
  return SecureStore.getItemAsync(KEY);
}

export async function setToken(token) {
  if (Platform.OS === 'web') {
    if (token) globalThis.localStorage?.setItem(KEY, token);
    else globalThis.localStorage?.removeItem(KEY);
    return;
  }
  if (token) await SecureStore.setItemAsync(KEY, token);
  else await SecureStore.deleteItemAsync(KEY);
}
