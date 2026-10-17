import { useEffect, useState } from 'preact/hooks';
import { formatCountdown } from '../lib/readiness';

/** Re-renders every second with the time left until `deadline`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Countdown({ deadline, class: className }: { deadline: string; class?: string }) {
  const now = useNow();
  const left = new Date(deadline).getTime() - now;
  return (
    <span class={className ?? 'countdown'} role="timer" aria-live="off">
      {formatCountdown(left)}
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}
