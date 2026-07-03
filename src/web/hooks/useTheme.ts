import { useState, useEffect } from "react";

/** Resolve the currently-applied theme (set on <html data-theme> by the no-FOUC script). */
function current(): "dark" | "light" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Manual light/dark theme, persisted to localStorage and applied as
 * <html data-theme="dark|light"> — which drives both the checkout CSS tokens
 * and Tailwind's `dark:` variants (darkMode selector [data-theme="dark"]).
 */
export function useTheme() {
  const [dark, setDark] = useState<boolean>(() => current() === "dark");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}
