import { useCallback, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "fantasytool.theme";

// index.html sets data-theme before React loads (saved choice, or the
// system setting on first visit). This hook reads it and handles changes.
function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  const toggleTheme = useCallback(() => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not remembered; the theme still changes for this visit.
    }
    setTheme(next);
  }, []);

  return { theme, toggleTheme };
}
