// Unit tests for the metadata stripper the upload-photo edge function uses.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../scripts/local-env.mjs';
import { InvalidJpeg, stripJpegMetadata } from '../supabase/functions/_shared/jpeg.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(ROOT, 'tests', 'fixtures', name)));
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

describe('stripJpegMetadata', () => {
  it.each(['exif-gps.jpg', 'exif-gps-progressive.jpg'])('removes EXIF, comments and trailers from %s', (name) => {
    const input = fixture(name);
    expect(text(input)).toContain('Exif');
    const { bytes, width, height, removed } = stripJpegMetadata(input);
    expect([width, height]).toEqual([64, 48]);
    expect(removed).toBeGreaterThanOrEqual(2);
    for (const s of ['Exif', 'TestCam', 'SerialModel', 'secret comment', 'TRAILER']) expect(text(bytes)).not.toContain(s);
    expect([bytes[0], bytes[1], bytes.at(-2), bytes.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it('is idempotent', () => {
    const once = stripJpegMetadata(fixture('exif-gps.jpg')).bytes;
    const twice = stripJpegMetadata(once);
    expect(twice.removed).toBe(0);
    expect(Buffer.from(twice.bytes).equals(Buffer.from(once))).toBe(true);
  });

  it.each([
    ['empty input', new Uint8Array()],
    ['a PNG', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['text', new TextEncoder().encode('hello world')],
    ['a truncated JPEG', fixture('exif-gps.jpg').subarray(0, 200)],
    ['a JPEG without image data', Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
  ])('rejects %s', (_label, input) => {
    expect(() => stripJpegMetadata(input)).toThrow(InvalidJpeg);
  });
});
