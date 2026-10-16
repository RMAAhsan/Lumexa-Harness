/**
 * HTTP client for the Express API. Sends the saved JWT and throws an Error with
 * the server's message on a non-2xx response.
 *   const courses = await api('/courses');
 *   await api('/bookings', { method: 'POST', body: { ... } });
 * On a phone, set EXPO_PUBLIC_API_URL to the API's address on your network
 * (e.g. http://192.168.1.20:3001). On web the API is the same origin.
 */
import { Platform } from 'react-native';
import { getToken } from './storage.js';

const BASE = Platform.OS === 'web' ? '' : (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001');

/** URL of a photo/video the server ships in server/public/media: <Image source={{ uri: mediaUrl('hero.jpg') }} /> */
export const mediaUrl = (file) => `${BASE}/media/${file}`;

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
