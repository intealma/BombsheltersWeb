import { defineConfig, loadEnv, type Plugin } from 'vite';
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

/**
 * Content Security Policy and security headers for production builds.
 * The policy goes into index.html as a meta tag (works on any host) and,
 * with the header-only parts, into dist/_headers (Netlify / Cloudflare Pages
 * format; see docs/hosting.md for other hosts). Not applied in dev, where
 * Vite's hot reload needs inline scripts.
 */
function securityHeaders(supabaseUrl: string, base: string): Plugin {
  const supabase = new URL(supabaseUrl).origin;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // Inline style attributes (progress bars, map) need this; no inline scripts are allowed.
    "style-src 'self' 'unsafe-inline'",
    // Signed photo links come from Supabase Storage; MapLibre uses data: and blob: images.
    `img-src 'self' data: blob: ${supabase}`,
    "font-src 'self'",
    // The API, and the basemap style, tiles and glyphs from OpenFreeMap.
    `connect-src 'self' ${supabase} https://tiles.openfreemap.org`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');

  const headers = [
    `${base}*`,
    `  Content-Security-Policy: ${csp}; frame-ancestors 'none'; upgrade-insecure-requests`,
    '  Strict-Transport-Security: max-age=63072000; includeSubDomains',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    '  Referrer-Policy: no-referrer',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Permissions-Policy: camera=(self), geolocation=(), microphone=(), payment=(), usb=()',
    '',
  ].join('\n');

  return {
    name: 'beredskap-security-headers',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: headers });
    },
  };
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

  // Served under /beredskap/; GitHub Pages serves the repo at /BombsheltersWeb/, so its
  // workflow sets BEREDSKAP_BASE=/BombsheltersWeb/beredskap/.
  const base = process.env.BEREDSKAP_BASE || '/beredskap/';

  return {
    base,
    plugins: [preact(), securityHeaders(env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321', base)],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: { outDir: 'dist', sourcemap: false },
  };
});
