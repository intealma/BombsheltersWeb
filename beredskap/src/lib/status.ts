// The seven review statuses. Every status has its own colour AND its own
// shape and symbol, so the map, legend and table never rely on colour alone.

export const STATUSES = ['ej_forelagd', 'forelagd', 'forsenad', 'inskickad', 'godkand', 'brister', 'platsbesok'] as const;
export type ReviewStatus = (typeof STATUSES)[number];

export type Shape = 'circle' | 'square' | 'triangle' | 'diamond';

export const STATUS_STYLE: Record<ReviewStatus, { color: string; shape: Shape; filled: boolean; glyph: '' | '!' | '✓' | '•' | 'P' }> = {
  ej_forelagd: { color: '#8b919c', shape: 'circle', filled: false, glyph: '' },
  forelagd: { color: '#7fb2ff', shape: 'square', filled: false, glyph: '' },
  forsenad: { color: '#ffb238', shape: 'square', filled: true, glyph: '!' },
  inskickad: { color: '#5fd3e8', shape: 'circle', filled: true, glyph: '•' },
  godkand: { color: '#4fd17a', shape: 'circle', filled: true, glyph: '✓' },
  brister: { color: '#ff6b6b', shape: 'triangle', filled: true, glyph: '!' },
  platsbesok: { color: '#d69bff', shape: 'diamond', filled: true, glyph: 'P' },
};

function shapePath(ctx: CanvasRenderingContext2D, shape: Shape, c: number, r: number) {
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(c, c, r, 0, Math.PI * 2);
  else if (shape === 'square') ctx.rect(c - r * 0.9, c - r * 0.9, r * 1.8, r * 1.8);
  else if (shape === 'triangle') {
    ctx.moveTo(c, c - r * 1.05);
    ctx.lineTo(c + r * 1.05, c + r * 0.85);
    ctx.lineTo(c - r * 1.05, c + r * 0.85);
    ctx.closePath();
  } else {
    ctx.moveTo(c, c - r * 1.1);
    ctx.lineTo(c + r * 1.1, c);
    ctx.lineTo(c, c + r * 1.1);
    ctx.lineTo(c - r * 1.1, c);
    ctx.closePath();
  }
}

/** Map icon for a status, drawn on a canvas at the device pixel ratio. */
export function statusIconImage(status: ReviewStatus, pixelRatio: number): { width: number; height: number; data: Uint8ClampedArray } {
  const style = STATUS_STYLE[status];
  const size = Math.round(22 * pixelRatio);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const r = size * 0.36;

  shapePath(ctx, style.shape, c, r);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.2 * pixelRatio; // dark outline so icons stand out on any background
  ctx.strokeStyle = '#000';
  ctx.stroke();
  if (style.filled) {
    ctx.fillStyle = style.color;
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fill();
    ctx.lineWidth = 1.8 * pixelRatio;
    ctx.strokeStyle = style.color;
    ctx.stroke();
  }
  if (style.glyph) {
    ctx.fillStyle = '#000';
    ctx.font = `700 ${Math.round(size * 0.42)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.glyph === '•' ? '●' : style.glyph, c, c + (style.shape === 'triangle' ? size * 0.06 : size * 0.02));
  }
  return { width: size, height: size, data: ctx.getImageData(0, 0, size, size).data };
}
