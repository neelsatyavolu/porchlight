import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fail, fakeApi, ok, renderPage, type Handler } from "../../auth/testing";
import { RequireSession } from "../../session";
import { Settings } from "../Settings";
import { PAIRING_POLL_MS } from "./FlintSection";

const TOKEN = {
  id: "t1",
  label: "Flint on Studio",
  scopes: ["imports:write"],
  createdAt: "2026-11-01T10:00:00.000Z",
  lastUsedAt: null,
};

const HOUR = 3_600_000;
const SESSIONS = [
  { id: "s-web", platform: "web", appVersion: null, createdAt: "2026-11-01T10:00:00.000Z", lastSeenAt: new Date().toISOString(), current: true },
  {
    id: "s-phone",
    platform: "ios",
    appVersion: "1.0 (7)",
    createdAt: "2026-11-02T10:00:00.000Z",
    lastSeenAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    current: false,
  },
];

function renderSettings(routes: Record<string, Handler>) {
  const fetch = fakeApi({ "GET /v1/tokens": () => ok({ tokens: [TOKEN] }), "GET /v1/sessions": () => ok({ sessions: SESSIONS }), ...routes });
  renderPage(
    <RequireSession>
      <Settings />
    </RequireSession>,
    { path: "/app/settings", route: "/app/settings", fetch },
  );
  return fetch;
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("Settings: account", () => {
  it("shows the email and signs out to /signin", async () => {
    const user = userEvent.setup();
    const fetch = renderSettings({ "POST /v1/auth/signout": () => ok({ signedOut: true }) });
    expect(await screen.findByText("a@b.c")).toBeInTheDocument();
    expect(screen.getByText("Signed in by email")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/signin$/));
    expect(fetch).toHaveBeenCalledWith("/v1/auth/signout", expect.objectContaining({ method: "POST" }));
  });

  it("deletes the account only after the word is typed", async () => {
    const user = userEvent.setup();
    const fetch = renderSettings({ "DELETE /v1/me": () => ok({ deleted: true }) });
    await user.click(await screen.findByRole("button", { name: "Delete account" }));
    const dialog = screen.getByRole("dialog", { name: "Delete your account" });
    const confirm = within(dialog).getByRole("button", { name: "Delete account" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type .delete. to confirm/), "Delete");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/signin$/));
    expect(fetch).toHaveBeenCalledWith("/v1/me", expect.objectContaining({ method: "DELETE" }));
  });

  it("keeps the sheet open and says why when delete fails", async () => {
    const user = userEvent.setup();
    renderSettings({ "DELETE /v1/me": () => fail(500, "internal", "Server error") });
    await user.click(await screen.findByRole("button", { name: "Delete account" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Type .delete. to confirm/), "delete");
    await user.click(within(dialog).getByRole("button", { name: "Delete account" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't delete your account. Server error");
  });
});

describe("Settings: sessions", () => {
  it("lists where you're signed in, marks this browser, and signs another device out", async () => {
    const user = userEvent.setup();
    const fetch = renderSettings({ "DELETE /v1/sessions/s-phone": () => ok({ deleted: true, signedOut: false }) });
    const list = await screen.findByRole("list", { name: "Signed-in devices" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Web browser")).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/This browser/)).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows[1]!).getByText("iPhone")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Last active 3 h ago · Version 1.0 \(7\)/)).toBeInTheDocument();

    await user.click(within(rows[1]!).getByRole("button", { name: "Sign out iPhone" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith("/v1/sessions/s-phone", expect.objectContaining({ method: "DELETE" }));
  });

  it("says why when signing a device out fails", async () => {
    const user = userEvent.setup();
    renderSettings({ "DELETE /v1/sessions/s-phone": () => fail(500, "internal", "Server error") });
    await user.click(await screen.findByRole("button", { name: "Sign out iPhone" }));
    expect(await screen.findByText("Couldn't sign out iPhone. Server error")).toBeInTheDocument();
  });

  it("offers a retry when sessions fail to load", async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderSettings({
      "GET /v1/sessions": () => {
        calls += 1;
        return calls === 1 ? fail(500, "internal", "Server error") : ok({ sessions: SESSIONS });
      },
    });
    expect(await screen.findByText(/Couldn't load your devices/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("iPhone")).toBeInTheDocument();
  });
});

describe("Settings: Flint", () => {
  it("lists paired tokens and revokes one", async () => {
    const user = userEvent.setup();
    const fetch = renderSettings({ "DELETE /v1/tokens/t1": () => ok({ deleted: true }) });
    const list = await screen.findByRole("list", { name: "Paired apps" });
    expect(within(list).getByText("Flint on Studio")).toBeInTheDocument();
    expect(within(list).getByText(/Not used yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke Flint on Studio" }));
    expect(await screen.findByText("Nothing is paired yet.")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/v1/tokens/t1", expect.objectContaining({ method: "DELETE" }));
  });

  it("shows the pairing code with a countdown, then says when it expired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const start = Date.now();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings({
      "POST /v1/pairing/start": () => ok({ code: "ABCD-EFGH", expiresAt: new Date(start + 10 * 60_000).toISOString() }, 201),
    });
    await user.click(await screen.findByRole("button", { name: "Pair Flint" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent(/Expires in (10:00|9:59)/);
    expect(screen.getByText(/In Flint, open Settings → Connections → Porchlight/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000 + 1_000);
    });
    expect(screen.getByText("This code has expired. Get a new one to pair Flint.")).toBeInTheDocument();
    expect(screen.queryByText("ABCD-EFGH")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get a new code" })).toBeInTheDocument();
  });

  it("hides the code once Flint claims it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let tokens = [TOKEN];
    renderSettings({
      "GET /v1/tokens": () => ok({ tokens }),
      "POST /v1/pairing/start": () => ok({ code: "WXYZ-2345", expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201),
    });
    await screen.findByText("Flint on Studio");
    await user.click(screen.getByRole("button", { name: "Pair Flint" }));
    expect(await screen.findByText("WXYZ-2345")).toBeInTheDocument();

    tokens = [...tokens, { ...TOKEN, id: "t2", label: "Flint on Laptop" }];
    await act(async () => {
      vi.advanceTimersByTime(PAIRING_POLL_MS);
    });
    expect(await screen.findByText("Flint on Laptop")).toBeInTheDocument();
    expect(screen.queryByText("WXYZ-2345")).not.toBeInTheDocument();
  });

  it("offers a retry when tokens fail to load", async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderSettings({
      "GET /v1/tokens": () => {
        calls += 1;
        return calls === 1 ? fail(500, "internal", "Server error") : ok({ tokens: [TOKEN] });
      },
    });
    expect(await screen.findByText(/Couldn't load paired apps/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Flint on Studio")).toBeInTheDocument();
  });

  it("sends an expired session to sign-in", async () => {
    renderSettings({ "GET /v1/tokens": () => fail(401, "unauthorized") });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/signin?next=%2Fapp%2Fsettings"));
  });
});

describe("Settings: Amazon and appearance", () => {
  it("explains Amazon connects from the native apps", async () => {
    renderSettings({});
    expect(await screen.findByText(/Connect Amazon in the Porchlight app on your Mac or iPhone/)).toBeInTheDocument();
  });

  it("switches and remembers the theme", async () => {
    const user = userEvent.setup();
    renderSettings({});
    const group = await screen.findByRole("radiogroup", { name: "Appearance" });
    expect(within(group).getByRole("radio", { name: "System" })).toBeChecked();
    await user.click(within(group).getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("porchlight.theme")).toBe("light");
    await user.click(within(group).getByRole("radio", { name: "System" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
