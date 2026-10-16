import { Tabs } from 'expo-router';
import { Home } from 'lucide-react-native';
import { theme } from '../../src/theme.js';

export default function TabsLayout() {
  const c = theme.colors;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary[600],
        tabBarInactiveTintColor: c.muted,
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.line },
        tabBarLabelStyle: { fontFamily: theme.fonts.bodyMedium, fontSize: 11 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: ({ color, size }) => <Home color={color} size={size} /> }} />
    </Tabs>
  );
}
