import { Navigate, Route, Routes } from "react-router-dom";
import { PackagesProvider } from "./data/packages";
import { AppShell } from "./layout/AppShell";
import { SessionGate } from "./layout/SessionGate";
import { AddPackage } from "./pages/AddPackage";
import { ConnectFlint } from "./pages/ConnectFlint";
import { NotFound } from "./pages/NotFound";
import { PackageDetail } from "./pages/PackageDetail";
import { PackageList } from "./pages/PackageList";
import { Settings } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { Verify } from "./pages/Verify";

/**
 * Route table. In production the Worker serves this app for /app/*, /signin*
 * and /auth/verify; / and the marketing pages come from site/ (README.md).
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/signin" element={<SignIn />} />
      <Route path="/signin/verify" element={<Verify />} />
      {/* The magic link the API sends today (docs/API.md, /auth/email/start). */}
      <Route path="/auth/verify" element={<Verify />} />
      <Route
        path="/app"
        element={
          <SessionGate>
            <PackagesProvider>
              <AppShell />
            </PackagesProvider>
          </SessionGate>
        }
      >
        <Route index element={<PackageList />} />
        <Route path="p/:id" element={<PackageDetail />} />
        <Route path="add" element={<AddPackage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="connect/flint" element={<ConnectFlint />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
