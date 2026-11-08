import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { fail, fakeApi, ok, renderPage, USER } from "../../auth/testing";
import { Verify } from "../Verify";

const SIGNED_OUT = { "GET /v1/me": () => fail(401, "unauthorized") };

function renderVerify(fetch: typeof globalThis.fetch, path = "/auth/verify?token=tok") {
  return renderPage(
    <StrictMode>
      <Verify />
    </StrictMode>,
    { path, route: "/auth/verify", fetch },
  );
}

afterEach(() => localStorage.clear());

describe("Verify", () => {
  it("trades the token once, even under StrictMode, and lands on the stored next", async () => {
    localStorage.setItem("porchlight.signin.next", "/app/settings");
    const fetch = fakeApi({ ...SIGNED_OUT, "POST /v1/auth/email/verify": () => ok({ token: null, user: USER, created: false }) });
    renderVerify(fetch);
    expect(screen.getByRole("heading", { name: "Signing you in" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/settings"));
    const verifyCalls = fetch.mock.calls.filter(([url]) => String(url) === "/v1/auth/email/verify");
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0]?.[1]?.body).toBe(JSON.stringify({ token: "tok", client: "web" }));
  });

  it("explains a spent link and links back to sign-in", async () => {
    const fetch = fakeApi({ ...SIGNED_OUT, "POST /v1/auth/email/verify": () => fail(401, "unauthorized") });
    renderVerify(fetch);
    expect(await screen.findByRole("heading", { name: "This link has expired or was already used." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Send a new link" })).toHaveAttribute("href", "/signin");
  });

  it("takes the token out of the address bar and still retries with it", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const fetch = fakeApi({
      ...SIGNED_OUT,
      "POST /v1/auth/email/verify": () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return ok({ token: null, user: USER, created: false });
      },
    });
    renderVerify(fetch);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/auth\/verify$/));
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/app$/));
    const bodies = fetch.mock.calls.filter(([url]) => String(url) === "/v1/auth/email/verify").map(([, init]) => init?.body);
    expect(bodies).toEqual([JSON.stringify({ token: "tok", client: "web" }), JSON.stringify({ token: "tok", client: "web" })]);
  });

  it("handles a link with no token without calling the API", () => {
    const fetch = fakeApi(SIGNED_OUT);
    renderVerify(fetch, "/auth/verify");
    expect(screen.getByRole("heading", { name: "This link is incomplete." })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith("/v1/auth/email/verify", expect.anything());
  });

  it("offers a retry when the network fails", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const fetch = fakeApi({
      ...SIGNED_OUT,
      "POST /v1/auth/email/verify": () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return ok({ token: null, user: USER, created: false });
      },
    });
    renderVerify(fetch);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/app$/));
  });
});
