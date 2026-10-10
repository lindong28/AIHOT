import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { THEME_BOOT_SCRIPT, getThemePreference, resolvedTheme, setThemePreference, exportBundle, importBundle } from "../app/lib/local-state.ts";

for (const systemDark of [false, true]) {
  test(`first paint defaults to light regardless of system dark=${systemDark}`, () => {
    for (const stored of [null, "auto", "system", "invalid"]) {
      let actual = "";
      runInNewContext(THEME_BOOT_SCRIPT, {
        localStorage: { getItem: () => stored },
        window: { matchMedia: () => ({ matches: systemDark }) },
        document: { documentElement: { setAttribute: (_: string, value: string) => actual = value }, querySelector: () => null },
      });
      assert.equal(actual, "light");
    }
    assert.equal(resolvedTheme(null), "light");
  });
}

for (const theme of ["light", "dark", "feedly"] as const) {
  test(`${theme} survives storage, first paint and backup round trips`, () => {
    const values = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
    try {
      setThemePreference(theme);
      assert.equal(getThemePreference(), theme);
      const backup = JSON.stringify(exportBundle());
      setThemePreference(null);
      assert.equal(importBundle(backup).themeApplied, true);
      assert.equal(getThemePreference(), theme);
      // Import must not overwrite an explicit choice.
      setThemePreference(theme === "dark" ? "light" : "dark");
      assert.equal(importBundle(backup).themeApplied, false);
      for (const stored of [theme, JSON.stringify(theme)]) {
        values.set("aihot-theme", stored);
        let actual = "";
        let chrome = "";
        runInNewContext(THEME_BOOT_SCRIPT, {
          localStorage,
          document: {
            documentElement: { setAttribute: (_: string, value: string) => actual = value },
            querySelector: () => ({ setAttribute: (_: string, value: string) => chrome = value }),
          },
        });
        assert.equal(actual, theme);
        assert.equal(getThemePreference(), theme);
        assert.equal(chrome, theme === "dark" ? "#13191c" : theme === "feedly" ? "#ffffff" : "#faf9f6");
      }
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
}

test("unavailable browser storage still boots into light", () => {
  let actual = "";
  runInNewContext(THEME_BOOT_SCRIPT, {
    localStorage: { getItem: () => { throw new Error("storage blocked"); } },
    document: { documentElement: { setAttribute: (_: string, value: string) => actual = value }, querySelector: () => null },
  });
  assert.equal(actual, "light");
});
