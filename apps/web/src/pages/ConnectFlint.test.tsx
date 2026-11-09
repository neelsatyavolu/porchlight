import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fail, fakeApi, ok, renderPage, type Handler } from "../auth/testing";
import { RequireSession } from "../session";
import { ConnectFlint } from "./ConnectFlint";
import { CONNECT_POLL_MS, openFlint } from "./settings/flint";

vi.mock("./settings/flint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings/flint")>()),
  openFlint: vi.fn(),
}));

const TOKEN = { id: "t1", label: "Flint on Studio", scopes: ["imports:write"], createdAt: "2026-11-01T10:00:00.000Z", lastUsedAt: null };

function renderConnect(routes: Record<string, Handler>) {
  const fetch = fakeApi({
    "GET /v1/tokens": () => ok({ tokens: [] }),
    "POST /v1/pairing/start": () => ok({ code: "WXYZ-2345", expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201),
    ...routes,
  });
  renderPage(
    <RequireSession>
      <ConnectFlint />
    </RequireSession>,
    { path: "/app/connect/flint", route: "/app/connect/flint", fetch },
  );
  return fetch;
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(openFlint).mockClear();
});

describe("/app/connect/flint", () => {
  it("makes a code and opens Flint right away, once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let tokens: (typeof TOKEN)[] = [];
    const fetch = renderConnect({ "GET /v1/tokens": () => ok({ tokens }) });
    expect(await screen.findByText("Opening Flint…")).toBeInTheDocument();
    expect(openFlint).toHaveBeenCalledTimes(1);
    expect(openFlint).toHaveBeenCalledWith(`flint://porchlight/pair?code=WXYZ-2345&host=${encodeURIComponent(window.location.host)}`);
    expect(fetch.mock.calls.filter(([url, init]) => url === "/v1/pairing/start" && init?.method === "POST")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Get Flint" })).toHaveAttribute("href", "https://flint.xanom.co");

    tokens = [TOKEN];
    await act(async () => {
      vi.advanceTimersByTime(CONNECT_POLL_MS);
    });
    expect(await screen.findByText("Connected to Flint on Studio")).toBeInTheDocument();
    expect(screen.getByText(/You can close this tab/)).toBeInTheDocument();
  });

  it("offers the code for typing into Flint", async () => {
    const user = userEvent.setup();
    renderConnect({});
    await user.click(await screen.findByRole("button", { name: "Use a code instead" }));
    expect(screen.getByText("WXYZ-2345")).toBeInTheDocument();
  });

  it("lets the user try again when the code can't be made", async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderConnect({
      "POST /v1/pairing/start": () => {
        calls += 1;
        return calls === 1 ? fail(500, "internal", "Server error") : ok({ code: "WXYZ-2345", expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201);
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't connect Flint/);
    expect(openFlint).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Opening Flint…")).toBeInTheDocument();
    expect(openFlint).toHaveBeenCalledTimes(1);
  });

  it("signs in first and comes back here", async () => {
    renderConnect({ "GET /v1/me": () => fail(401, "unauthorized") });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/signin?next=%2Fapp%2Fconnect%2Fflint"));
    expect(openFlint).not.toHaveBeenCalled();
  });
});
