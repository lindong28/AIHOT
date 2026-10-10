import { useEffect, type ReactNode } from "react";
import { IconMoon, IconSun } from "../icons";
import { applyTheme, setThemePreference, useThemePreference, type ThemePreference } from "../../lib/local-state";

type Choice = NonNullable<ThemePreference>;

const OPTIONS: Array<{ key: Choice; label: string; icon?: ReactNode }> = [
  { key: "light", label: "亮色", icon: <IconSun size={13} /> },
  { key: "dark", label: "暗色", icon: <IconMoon size={13} /> },
  { key: "feedly", label: "Feedly" },
  { key: "github", label: "GitHub" },
];

/**
 * Independent visual styles; the original light style is the default. Two rows of two keep every
 * label whole in the 180px sidebar.
 */
export function ThemeSwitch({ className = "" }: { className?: string }) {
  const pref = useThemePreference();
  // Read current storage on hydration and on import / cross-tab notifications.
  useEffect(() => applyTheme(), [pref]);
  const current: Choice = pref ?? "light";
  const index = Math.max(0, OPTIONS.findIndex((o) => o.key === current));

  const choose = (key: Choice) => {
    const apply = () => {
      setThemePreference(key);
      applyTheme(key);
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(apply);
    else apply();
  };

  return (
    <div role="radiogroup" aria-label="外观" className={`theme-switch relative grid h-[60px] grid-cols-2 grid-rows-2 rounded-[17px] border border-line bg-bg-sunk p-[3px] ${className}`}>
      <span
        aria-hidden="true"
        className="theme-switch-thumb absolute left-[3px] top-[3px] h-[calc((100%-6px)/2)] w-[calc((100%-6px)/2)] rounded-full border border-line bg-surface shadow-[var(--shadow-card)] transition-transform duration-200 ease-[var(--ease-out-quart)]"
        style={{ transform: `translate(${(index % 2) * 100}%, ${Math.floor(index / 2) * 100}%)` }}
      />
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={current === o.key}
          title={o.label}
          onClick={() => choose(o.key)}
          className={`relative z-10 flex min-w-0 items-center justify-center gap-1 rounded-full text-[11px] transition-colors duration-150 ${current === o.key ? "text-ink" : "text-ink-4 hover:text-ink-2"}`}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
