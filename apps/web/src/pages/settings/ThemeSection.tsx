import { useState } from "react";
import { readTheme, saveTheme, THEME_CHOICES, type ThemeChoice } from "./theme";

const LABELS: Record<ThemeChoice, string> = { system: "System", dark: "Dark", light: "Light" };

/** A three-way segmented radio group. Local to Settings; not a shared primitive. */
export function ThemeSection() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);

  function pick(next: ThemeChoice) {
    setChoice(next);
    saveTheme(next);
  }

  return (
    <section className="settings__section" aria-labelledby="settings-theme">
      <h2 id="settings-theme" className="settings__title">
        Appearance
      </h2>
      <div className="settings__segments" role="radiogroup" aria-labelledby="settings-theme">
        {THEME_CHOICES.map((value) => (
          <label key={value} className="settings__segment">
            <input type="radio" name="theme" value={value} checked={choice === value} onChange={() => pick(value)} />
            <span>{LABELS[value]}</span>
          </label>
        ))}
      </div>
      <p className="settings__caption">Saved in this browser only.</p>
    </section>
  );
}
