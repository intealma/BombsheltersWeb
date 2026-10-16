// The public map must never carry readiness, deficiency or inspection data.
// These checks need no database.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../scripts/local-env.mjs';

const REPO = path.resolve(ROOT, '..');
const PUBLIC_PROPERTIES = new Set(['id', 'address', 'capacity', 'municipality']);

describe('public shelters.geojson', () => {
  const geojson = JSON.parse(readFileSync(path.join(REPO, 'shelters.geojson'), 'utf8'));

  it('has only the four public properties on every feature', () => {
    const extra = new Set<string>();
    for (const f of geojson.features) {
      for (const key of Object.keys(f.properties)) if (!PUBLIC_PROPERTIES.has(key)) extra.add(key);
    }
    expect([...extra]).toEqual([]);
  });

  it('is unchanged in size (all of Sweden)', () => {
    expect(geojson.features.length).toBeGreaterThan(60000);
  });
});

describe('beredskap production bundle', () => {
  const dist = path.join(ROOT, 'dist');

  it.skipIf(!existsSync(dist))('contains no service role or secret key', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(js|html|css|json|map)$/.test(name)) files.push(p);
      }
    };
    walk(dist);
    const demoPassword = process.env.DEMO_PASSWORD;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/sb_secret_[A-Za-z0-9]/);
      if (demoPassword) expect(text.includes(demoPassword), `${file} contains DEMO_PASSWORD`).toBe(false);
      // Any embedded JWT (the anon key is fine) must not carry the service role.
      for (const jwt of text.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g) ?? []) {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
        expect(payload.role, file).not.toBe('service_role');
      }
    }
  });
});
