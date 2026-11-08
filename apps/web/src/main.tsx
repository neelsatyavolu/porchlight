// Global styles come first: component CSS imported through App must load after
// base.css, or `.mono` (13px) beats `.settings__code` (22px) on equal specificity.
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { applyTheme, readTheme } from "./pages/settings/theme";
import { SessionProvider } from "./session";

// The saved theme (Settings > Appearance) applies on every route.
applyTheme(readTheme());

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
