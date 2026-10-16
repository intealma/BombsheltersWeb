import { getLang, t, tn } from '../i18n';

const locale = () => (getLang() === 'en' ? 'en-GB' : 'sv-SE');

/** Date and time in Swedish time, whatever the device's time zone is. */
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(locale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Stockholm',
  }).format(new Date(iso));
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeZone: 'Europe/Stockholm' }).format(new Date(iso));
}

export function formatNumber(n: number): string {
  return n.toLocaleString(locale());
}

/** Short, readable reference for a receipt: first 8 characters of the id. */
export function receiptNumber(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

/** "5 OK · 1 brist · 1 ej tillämplig" */
export function checkCounts(ok: number, brist: number, na: number): string {
  return [t('check.countOk', { n: ok }), tn('check.countBrist', brist), tn('check.countNa', na)].join(' · ');
}
