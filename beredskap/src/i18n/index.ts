import { useEffect, useState } from 'preact/hooks';
import sv from './sv.json';
import en from './en.json';

// Swedish is the default; English is secondary. Every UI string lives in the
// JSON files next to this one.
const dictionaries = { sv, en } as const;
export type Lang = keyof typeof dictionaries;

const STORAGE_KEY = 'beredskap-lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'sv' || saved === 'en') return saved;
  } catch {
    // Storage can be unavailable (private mode); fall back to Swedish.
  }
  return 'sv';
}

let current: Lang = initialLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  current = lang;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not fatal.
  }
  listeners.forEach((fn) => fn());
}

function lookup(dict: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict);
  return typeof value === 'string' ? value : undefined;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const text = lookup(dictionaries[current], key) ?? lookup(dictionaries.sv, key) ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`)) : text;
}

/** Count-aware variant: uses `<key>_one` for exactly one, if it exists. */
export function tn(key: string, n: number, vars?: Record<string, string | number>): string {
  const one = n === 1 && lookup(dictionaries[current], `${key}_one`) !== undefined;
  return t(one ? `${key}_one` : key, { n, ...vars });
}

/** Re-renders the calling component when the language changes. */
export function useLang(): Lang {
  const [lang, setState] = useState(current);
  useEffect(() => {
    const fn = () => setState(current);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return lang;
}

document.documentElement.lang = current;
