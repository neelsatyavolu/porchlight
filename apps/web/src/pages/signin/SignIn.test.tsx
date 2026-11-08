import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppleCancelled } from "../../auth/apple";
import { fail, fakeApi, ok, renderPage, USER } from "../../auth/testing";
import { SignIn } from "../SignIn";

const SIGNED_OUT = { "GET /v1/me": () => fail(401, "unauthorized") };
const APPLE = { clientId: "svc", redirectUri: "https://x.test/signin" };

function renderSignIn(fetch: typeof globalThis.fetch, path = "/signin?next=%2Fapp%2Fsettings", props = {}) {
  return renderPage(<SignIn apple={null} {...props} />, { path, route: "/signin", fetch });
}

afterEach(() => localStorage.clear());

describe("SignIn", () => {
  it("sends a link, then signs in with the 6-digit code and goes to next", async () => {
    const user = userEvent.setup();
    const fetch = fakeApi({
      ...SIGNED_OUT,
      "POST /v1/auth/email/start": () => ok({ sent: true }, 202),
      "POST /v1/auth/email/verify": () => ok({ token: null, user: USER, created: false }),
    });
    renderSignIn(fetch);

    await user.type(screen.getByLabelText("Email"), "a@b.c");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/v1/auth/email/start", expect.objectContaining({ body: JSON.stringify({ email: "a@b.c", client: "web" }) }));
    expect(localStorage.getItem("porchlight.signin.next")).toBe("/app/settings");

    await user.type(screen.getByLabelText("Or enter the code from the email"), "12 34ab56");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/settings"));
    expect(fetch).toHaveBeenCalledWith(
      "/v1/auth/email/verify",
      expect.objectContaining({ body: JSON.stringify({ email: "a@b.c", code: "123456", client: "web" }) }),
    );
  });

  it("checks the email before calling the API", async () => {
    const user = userEvent.setup();
    const fetch = fakeApi(SIGNED_OUT);
    renderSignIn(fetch);
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter an email address");
    expect(fetch).not.toHaveBeenCalledWith("/v1/auth/email/start", expect.anything());
  });

  it("says when email sign-in isn't configured (503)", async () => {
    const user = userEvent.setup();
    const fetch = fakeApi({ ...SIGNED_OUT, "POST /v1/auth/email/start": () => fail(503, "unavailable") });
    renderSignIn(fetch);
    await user.type(screen.getByLabelText("Email"), "a@b.c");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email sign-in isn't set up on this server yet.");
  });

  it("shows the wait from Retry-After on 429", async () => {
    const user = userEvent.setup();
    const fetch = fakeApi({
      ...SIGNED_OUT,
      "POST /v1/auth/email/start": () => fail(429, "rate_limited", "slow", { "retry-after": "240" }),
    });
    renderSignIn(fetch);
    await user.type(screen.getByLabelText("Email"), "a@b.c");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many tries. Try again in 4 min.");
  });

  it("says a wrong code is wrong and stays on the code step", async () => {
    const user = userEvent.setup();
    const fetch = fakeApi({
      ...SIGNED_OUT,
      "POST /v1/auth/email/start": () => ok({ sent: true }, 202),
      "POST /v1/auth/email/verify": () => fail(401, "unauthorized"),
    });
    renderSignIn(fetch);
    await user.type(screen.getByLabelText("Email"), "a@b.c");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    await user.type(await screen.findByLabelText("Or enter the code from the email"), "000000");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is wrong or has expired.");
    expect(screen.getByRole("heading", { name: "Check your email" })).toBeInTheDocument();
  });

  it("ignores an outside next and goes to /app", async () => {
    const user = userEvent.setup();
    const fetch = fakeApi({
      ...SIGNED_OUT,
      "POST /v1/auth/email/start": () => ok({ sent: true }, 202),
      "POST /v1/auth/email/verify": () => ok({ token: null, user: USER, created: true }),
    });
    renderSignIn(fetch, "/signin?next=https%3A%2F%2Fevil.example");
    await user.type(screen.getByLabelText("Email"), "a@b.c");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    await user.type(await screen.findByLabelText("Or enter the code from the email"), "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/app$/));
  });

  it("sends a signed-in visitor straight to next", async () => {
    renderSignIn(fakeApi({}));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/settings"));
  });

  it("hides Sign in with Apple without a client id", () => {
    renderSignIn(fakeApi(SIGNED_OUT));
    expect(screen.queryByRole("button", { name: "Sign in with Apple" })).not.toBeInTheDocument();
  });

  it("posts Apple's identity token and raw nonce to /v1/auth/apple", async () => {
    const user = userEvent.setup();
    const startApple = vi.fn(async () => ({ identityToken: "jwt", nonce: "raw" }));
    const fetch = fakeApi({ ...SIGNED_OUT, "POST /v1/auth/apple": () => ok({ token: null, user: USER, created: false }) });
    renderSignIn(fetch, "/signin", { apple: APPLE, startApple });
    await user.click(screen.getByRole("button", { name: "Sign in with Apple" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/app$/));
    expect(startApple).toHaveBeenCalledWith(APPLE);
    expect(fetch).toHaveBeenCalledWith(
      "/v1/auth/apple",
      expect.objectContaining({ body: JSON.stringify({ identityToken: "jwt", nonce: "raw", client: "web" }) }),
    );
  });

  it("stays quiet when the Apple popup is closed", async () => {
    const user = userEvent.setup();
    const startApple = vi.fn(async () => {
      throw new AppleCancelled();
    });
    renderSignIn(fakeApi(SIGNED_OUT), "/signin", { apple: APPLE, startApple });
    await user.click(screen.getByRole("button", { name: "Sign in with Apple" }));
    await waitFor(() => expect(startApple).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains a rejected Apple token", async () => {
    const user = userEvent.setup();
    const startApple = vi.fn(async () => ({ identityToken: "jwt", nonce: "raw" }));
    const fetch = fakeApi({ ...SIGNED_OUT, "POST /v1/auth/apple": () => fail(401, "unauthorized") });
    renderSignIn(fetch, "/signin", { apple: APPLE, startApple });
    await user.click(screen.getByRole("button", { name: "Sign in with Apple" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Apple couldn't confirm this sign-in.");
  });
});
