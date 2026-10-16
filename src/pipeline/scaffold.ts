/**
 * Build the starting app for the plan's platform from the templates:
 *   web     server/ + client/            (Express + Prisma, React + Vite + Tailwind)
 *   mobile  server/ + mobile/            (Express + Prisma, Expo + React Native)
 *   both    server/ + client/ + mobile/  (website at /, app's web build at /app)
 * then apply the design, npm install, and (mobile) install the brand fonts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec } from '../agent/exec.js';
import { HARNESS_ROOT, TEMPLATE_DIR } from '../config.js';
import { applyDesign, applyMobileTheme, fontPackage, pickWeight, type DesignSpec, type MobileFonts } from './design.js';
import type { Plan } from './plan.js';

const MOBILE_TEMPLATE = path.join(HARNESS_ROOT, 'templates', 'mobile');

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

function rootPackageJson(plan: Plan): string {
  const web = plan.platform !== 'mobile';
  const mobile = plan.platform !== 'web';
  const scripts: Record<string, string> = {
    setup: 'docker compose up -d --wait && npm run db:migrate -w server && npm run db:seed -w server',
    'dev:server': 'node --watch server/src/index.js',
    ...(web ? { 'dev:client': 'npm run dev -w client' } : {}),
    ...(mobile ? { 'dev:mobile': 'npm run start -w mobile' } : {}),
    build: [web ? 'npm run build -w client' : '', mobile ? 'npm run build:web -w mobile' : ''].filter(Boolean).join(' && '),
    start: 'NODE_ENV=production node server/src/index.js',
    test: 'npm test -w server',
  };
  return `${JSON.stringify({ name: slug(plan.appName), private: true, type: 'module', workspaces: ['server', ...(web ? ['client'] : []), ...(mobile ? ['mobile'] : [])], scripts }, null, 2)}\n`;
}

function configureExpo(appDir: string, plan: Plan): void {
  const file = path.join(appDir, 'mobile', 'app.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { expo: Record<string, any> };
  const s = slug(plan.appName);
  const id = `com.${s.replace(/-/g, '').slice(0, 30) || 'app'}.app`;
  config.expo.name = plan.appName;
  config.expo.slug = s;
  config.expo.scheme = s;
  config.expo.ios.bundleIdentifier = id;
  config.expo.android.package = id;
  config.expo.experiments.baseUrl = plan.platform === 'both' ? '/app' : '';
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function mobileReadme(plan: Plan): string {
  return `
## Mobile app (mobile/)

Expo + React Native: one codebase for iOS and Android${plan.platform === 'both' ? ' (its web build is served at /app)' : ' (its web build is served at /)'}.

\`\`\`bash
npm run dev:server                       # the API on :3001
npm run dev:mobile                       # Expo dev server: scan the QR code with the Expo Go app
\`\`\`

On a phone, the app must reach the API over your network: create \`mobile/.env\` with
\`EXPO_PUBLIC_API_URL=http://<your-computer-ip>:3001\`.
Store builds: \`npx eas build -p ios\` / \`-p android\` (needs an Expo account; iOS also needs an Apple developer account).
`;
}

/** Every .ttf in an @expo-google-fonts package, as export names (Fraunces_700Bold...). */
function fontExports(appDir: string, family: string): string[] {
  const roots = [path.join(appDir, 'node_modules', fontPackage(family)), path.join(appDir, 'mobile', 'node_modules', fontPackage(family))];
  const dir = roots.find((d) => fs.existsSync(d));
  if (!dir) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.ttf')) out.push(e.name.slice(0, -4));
    }
  };
  walk(dir);
  return [...new Set(out)];
}

async function installMobileFonts(appDir: string, spec: DesignSpec, env: Record<string, string>): Promise<{ fonts: MobileFonts; note: string }> {
  const families = [...new Set([spec.fonts.display, spec.fonts.body])];
  const r = await exec(`npm install --no-audit --no-fund ${families.map((f) => `${fontPackage(f)}@^0.2.0`).join(' ')} -w mobile`, {
    cwd: appDir,
    timeoutMs: 300_000,
    env,
  });
  if (r.code !== 0) return { fonts: {}, note: `brand fonts not installed (system fonts used): ${r.output.split('\n').slice(-3).join(' ')}` };
  const display = fontExports(appDir, spec.fonts.display);
  const body = fontExports(appDir, spec.fonts.body);
  const fonts: MobileFonts = {
    display: pickWeight(display, spec.fonts.display, ['700Bold', '600SemiBold', '800ExtraBold', '500Medium', '400Regular']),
    body: pickWeight(body, spec.fonts.body, ['400Regular', '500Medium']),
    bodyMedium: pickWeight(body, spec.fonts.body, ['500Medium', '600SemiBold', '400Regular']),
    bodySemibold: pickWeight(body, spec.fonts.body, ['600SemiBold', '700Bold', '500Medium', '400Regular']),
  };
  return { fonts, note: `fonts ${Object.values(fonts).filter(Boolean).join(', ') || 'none found'}` };
}

export async function scaffoldApp(opts: { appDir: string; plan: Plan; design?: DesignSpec; env: Record<string, string> }): Promise<string[]> {
  const { appDir, plan, design, env } = opts;
  const notes: string[] = [];
  fs.cpSync(TEMPLATE_DIR, appDir, { recursive: true, filter: (src) => !/node_modules|\/dist(\/|$)/.test(src) });
  if (plan.platform === 'mobile') fs.rmSync(path.join(appDir, 'client'), { recursive: true, force: true });
  if (plan.platform !== 'web') {
    fs.cpSync(MOBILE_TEMPLATE, path.join(appDir, 'mobile'), { recursive: true, filter: (src) => !/node_modules|\/dist(\/|$)|\.expo/.test(src) });
    configureExpo(appDir, plan);
    fs.appendFileSync(path.join(appDir, 'README.md'), mobileReadme(plan));
  }
  fs.writeFileSync(path.join(appDir, 'package.json'), rootPackageJson(plan));
  fs.mkdirSync(path.join(appDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'docs', 'PLAN.json'), JSON.stringify(plan, null, 2));
  if (design) applyDesign(appDir, design);

  const install = await exec('npm install --no-audit --no-fund', { cwd: appDir, timeoutMs: 900_000, env });
  if (install.code !== 0) throw new Error(`npm install failed in the scaffold:\n${install.output}`);

  if (plan.platform !== 'web' && design) {
    const { fonts, note } = await installMobileFonts(appDir, design, env);
    applyMobileTheme(appDir, design, fonts);
    notes.push(note);
  }
  notes.push(`platform ${plan.platform}: ${['server', plan.platform !== 'mobile' ? 'client' : '', plan.platform !== 'web' ? 'mobile' : ''].filter(Boolean).join(' + ')}`);
  return notes;
}
