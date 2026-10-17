import { t } from '../i18n';
import { STATUS_STYLE, type ReviewStatus } from '../lib/status';

/** The same shape and symbol as the map icon, as inline SVG. */
export function StatusShape({ status, size = 16 }: { status: ReviewStatus; size?: number }) {
  const s = STATUS_STYLE[status];
  const fill = s.filled ? s.color : 'transparent';
  const stroke = s.filled ? '#000' : s.color;
  const shape =
    s.shape === 'circle' ? <circle cx="10" cy="10" r="7.2" />
    : s.shape === 'square' ? <rect x="3.5" y="3.5" width="13" height="13" />
    : s.shape === 'triangle' ? <path d="M10 2.6 17.8 16.6H2.2Z" />
    : <path d="M10 1.8 18.2 10 10 18.2 1.8 10Z" />;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" class="status-shape">
      <g fill={fill} stroke={stroke} stroke-width={s.filled ? 1.2 : 2} stroke-linejoin="round">{shape}</g>
      {s.glyph && (
        <text x="10" y={s.shape === 'triangle' ? 14.6 : 13.8} text-anchor="middle" font-size="9.5" font-weight="700" fill="#000">
          {s.glyph}
        </text>
      )}
    </svg>
  );
}

/** Icon plus label: never colour alone. */
export function StatusBadge({ status }: { status: ReviewStatus }) {
  return (
    <span class={`status-badge status-${status}`}>
      <StatusShape status={status} />
      {t(`status.${status}`)}
    </span>
  );
}
