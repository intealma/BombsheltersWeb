// Removes metadata from a JPEG without decoding it.
//
// Keeps only what is needed to display the image: frame and scan headers,
// quantisation and Huffman tables, restart intervals, and the JFIF APP0
// segment. Drops APP1–APP15 (EXIF with GPS coordinates, XMP, camera serial
// numbers, embedded thumbnails, ICC profiles, Photoshop/IPTC data), comments,
// and anything appended after the end-of-image marker.
//
// Pure TypeScript, no Deno or Node APIs, so the same file runs in the edge
// function and in the tests.

export class InvalidJpeg extends Error {}

export interface StrippedJpeg {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Number of metadata segments removed. */
  removed: number;
}

// Start-of-frame markers (baseline, progressive, lossless, arithmetic).
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const SOS = 0xda;
const EOI = 0xd9;

const isRestart = (m: number) => m >= 0xd0 && m <= 0xd7;
const isMetadata = (m: number) => (m >= 0xe1 && m <= 0xef) || m === 0xfe;

export function stripJpegMetadata(input: Uint8Array): StrippedJpeg {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    throw new InvalidJpeg('not a JPEG file');
  }

  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let pos = 2;
  let width = 0;
  let height = 0;
  let removed = 0;
  let sawScan = false;
  let sawEnd = false;

  while (pos < input.length) {
    if (input[pos] !== 0xff) throw new InvalidJpeg('corrupt marker');
    while (pos < input.length && input[pos] === 0xff) pos++; // fill bytes
    if (pos >= input.length) break;
    const marker = input[pos++];

    if (marker === EOI) {
      parts.push(Uint8Array.of(0xff, EOI));
      sawEnd = true;
      break; // anything after EOI (trailers, second images) is dropped
    }
    if (isRestart(marker) || marker === 0x01) {
      parts.push(Uint8Array.of(0xff, marker));
      continue;
    }

    if (pos + 2 > input.length) throw new InvalidJpeg('truncated segment');
    const length = (input[pos] << 8) | input[pos + 1];
    if (length < 2 || pos + length > input.length) throw new InvalidJpeg('truncated segment');
    const segment = input.subarray(pos, pos + length);
    pos += length;

    if (SOF.has(marker)) {
      if (length < 8) throw new InvalidJpeg('bad frame header');
      height = (segment[3] << 8) | segment[4];
      width = (segment[5] << 8) | segment[6];
    }

    if (isMetadata(marker)) {
      removed++;
    } else {
      parts.push(Uint8Array.of(0xff, marker), segment);
    }

    if (marker === SOS) {
      sawScan = true;
      // Entropy-coded data runs until the next marker that is not a stuffed
      // byte (FF 00) or a restart marker (FF D0–D7).
      const start = pos;
      while (pos < input.length) {
        if (input[pos] === 0xff && pos + 1 < input.length) {
          const next = input[pos + 1];
          if (next === 0x00 || isRestart(next)) {
            pos += 2;
            continue;
          }
          if (next === 0xff) {
            pos += 1;
            continue;
          }
          break;
        }
        pos++;
      }
      parts.push(input.subarray(start, pos));
    }
  }

  if (!sawScan) throw new InvalidJpeg('no image data');
  if (!sawEnd) throw new InvalidJpeg('missing end of image');
  if (!width || !height) throw new InvalidJpeg('no frame header');

  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return { bytes, width, height, removed };
}
