import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';

/** Role claim of a legacy Supabase JWT key, or undefined. */
function jwtRole(value: string): string | undefined {
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[0].startsWith('eyJ')) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role;
  } catch {
    return undefined;
  }
}

export default defineConfig(({ mode }) => {
  // Everything prefixed VITE_ ends up in the browser bundle. Refuse to build
  // if a secret key was put there by mistake.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  for (const [key, value] of Object.entries(env)) {
    if (value.startsWith('sb_secret_') || jwtRole(value) === 'service_role') {
      throw new Error(`${key} holds a secret Supabase key. Only the anon (public) key may use a VITE_ prefix.`);
    }
  }

  return {
    base: '/beredskap/',
    plugins: [preact()],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: { outDir: 'dist', sourcemap: false },
  };
});
