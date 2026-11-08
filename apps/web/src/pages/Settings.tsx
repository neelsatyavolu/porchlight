// /app/settings (DESIGN.md §7 "Settings"): Account, Devices, Flint, Amazon, Appearance.
import { AccountSection } from "./settings/AccountSection";
import { AmazonSection } from "./settings/AmazonSection";
import { FlintSection } from "./settings/FlintSection";
import { SessionsSection } from "./settings/SessionsSection";
import { ThemeSection } from "./settings/ThemeSection";
import "./settings/Settings.css";

export function Settings() {
  return (
    <div className="settings">
      <h1 className="settings__page-title">Settings</h1>
      <AccountSection />
      <SessionsSection />
      <FlintSection />
      <AmazonSection />
      <ThemeSection />
    </div>
  );
}
