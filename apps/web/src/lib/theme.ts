import { useCallback, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'bln-theme';

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/** System-following by default; an explicit choice sets data-theme on <html> (see index.html for first paint). */
export function useTheme() {
  const [theme, setState] = useState<Theme>(read);
  const setTheme = useCallback((t: Theme) => {
    setState(t);
    const root = document.documentElement;
    if (t === 'system') delete root.dataset.theme;
    else root.dataset.theme = t;
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }, []);
  return { theme, setTheme };
}
