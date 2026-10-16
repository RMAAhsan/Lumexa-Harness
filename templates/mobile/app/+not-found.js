import { Link } from 'expo-router';
import { H2, Muted, Screen, Stack } from '../src/ui/index.js';

export default function NotFound() {
  return (
    <Screen>
      <Stack gap={8}>
        <H2>Screen not found</H2>
        <Link href="/"><Muted>Go home</Muted></Link>
      </Stack>
    </Screen>
  );
}
