import type { Status } from '../lib/drafts';

/** Each status has its own shape, so it never depends on colour alone. */
export function StatusIcon({ status, class: className }: { status: Status | undefined; class?: string }) {
  return (
    <svg class={className ?? 'status-icon'} viewBox="0 0 24 24" aria-hidden="true">
      {status === 'ok' && (
        <>
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
        </>
      )}
      {status === 'brist' && (
        <>
          <path d="M12 2.8 22 20.5H2Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          <path d="M12 9v5.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
          <circle cx="12" cy="17.6" r="1.4" fill="currentColor" />
        </>
      )}
      {status === 'ej_tillampligt' && (
        <>
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.4" />
          <path d="M7.5 12h9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
        </>
      )}
      {!status && <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" opacity="0.45" />}
    </svg>
  );
}
