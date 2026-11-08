import { NavLink, Outlet } from "react-router-dom";
import "./AppShell.css";

const LINKS = [
  { to: "/app", label: "Packages", end: true },
  { to: "/app/add", label: "Add", end: false },
  { to: "/app/settings", label: "Settings", end: false },
] as const;

/** Signed-in frame: 56px nav with a hairline, then a 720px content column. */
export function AppShell() {
  return (
    <div className="shell">
      <header className="shell__nav">
        <div className="shell__inner shell__bar">
          <NavLink to="/app" className="shell__mark">
            Porchlight
          </NavLink>
          <nav aria-label="Main">
            <ul className="shell__links">
              {LINKS.map((l) => (
                <li key={l.to}>
                  <NavLink to={l.to} end={l.end} className="shell__link">
                    {l.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main className="shell__inner shell__main">
        <Outlet />
      </main>
    </div>
  );
}
