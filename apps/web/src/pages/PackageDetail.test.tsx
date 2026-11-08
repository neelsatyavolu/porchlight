import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pending } from "../packages/pending";
import { fakeServer, makeEvent, makePackage as pkg, renderPages, writes, type FakeResponse, type Handler } from "../packages/testing";
import { PackageDetail } from "./PackageDetail";
import { PackageList } from "./PackageList";

afterEach(() => pending.reset());

const routes = (
  <>
    <Route path="/app" element={<PackageList />} />
    <Route path="/app/p/:id" element={<PackageDetail />} />
  </>
);

const LAMP = pkg("p1", {
  title: "Desk lamp",
  merchant: "IKEA",
  orderId: "112-1234567-1234567",
  source: "amazon",
  carrier: "ups",
  trackingNumber: "1Z999AA10123456784",
  status: "in_transit",
  statusDetail: "Departed facility",
  etaEnd: "2026-11-12",
  etaDateOnly: true,
  lastCheckedAt: "2026-11-08T17:46:00.000Z",
  items: [
    { name: "Desk lamp", imageUrl: "https://m.media-amazon.com/x.jpg", quantity: 1 },
    { name: "LED bulb", imageUrl: null, quantity: 2 },
  ],
});

const EVENTS = [
  makeEvent("e2", "p1", "2026-11-08T17:12:00.000Z", { description: "Departed facility", location: "Oakland, CA" }),
  makeEvent("e1", "p1", "2026-11-07T20:00:00.000Z", { description: "Label created", status: "label_created" }),
];

/** A handler that holds one request until `release` is called with its answer. */
function hold(match: (method: string, path: string) => boolean) {
  let release: (res: FakeResponse) => void = () => undefined;
  const handler: Handler = (method, path) =>
    match(method, path) ? new Promise<FakeResponse>((resolve) => (release = resolve)) : undefined;
  return { handler, release: (res: FakeResponse) => release(res) };
}

describe("PackageDetail", () => {
  it("shows status, ETA, facts, items and the timeline", async () => {
    renderPages("/app/p/p1", routes, fakeServer({ packages: [LAMP], events: EVENTS }));

    expect(await screen.findByRole("heading", { level: 1, name: "Desk lamp" })).toBeInTheDocument();
    expect(screen.getByText("Arriving Thursday, Nov 12")).toBeInTheDocument();
    expect(screen.getByText("In transit")).toBeInTheDocument();

    const number = screen.getByText("1Z999AA10123456784");
    expect(number).toHaveClass("mono");
    expect(screen.getByRole("link", { name: "Track on UPS site" })).toHaveAttribute(
      "href",
      "https://www.ups.com/track?tracknum=1Z999AA10123456784",
    );
    expect(screen.getByText("From Amazon")).toBeInTheDocument();
    expect(screen.getByText("112-1234567-1234567")).toHaveClass("mono");
    expect(screen.getByText("14 min ago")).toHaveAttribute("dateTime", "2026-11-08T17:46:00.000Z");

    const items = within(screen.getByRole("region", { name: "Items" }));
    expect(items.getByText("LED bulb")).toBeInTheDocument();
    expect(items.getByText("Qty 2")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull(); // no Amazon CDN images (DESIGN.md §6)

    const timeline = within(screen.getByRole("region", { name: "Timeline" }));
    expect(timeline.getByRole("heading", { name: "Sun, Nov 8" })).toBeInTheDocument();
    expect(timeline.getByText("Oakland, CA · 9:12 AM")).toBeInTheDocument();
    expect(timeline.getByRole("heading", { name: "Sat, Nov 7" })).toBeInTheDocument();
  });

  it("copies the tracking number", async () => {
    const user = userEvent.setup();
    renderPages("/app/p/p1", routes, fakeServer({ packages: [LAMP] }));
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe("1Z999AA10123456784");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("cancels the Copied label timer when the page goes away", async () => {
    const user = userEvent.setup();
    const set = vi.spyOn(window, "setTimeout");
    const clear = vi.spyOn(window, "clearTimeout");
    try {
      const { unmount } = renderPages("/app/p/p1", routes, fakeServer({ packages: [LAMP] }));
      await user.click(await screen.findByRole("button", { name: "Copy" }));
      const index = set.mock.calls.findIndex(([, ms]) => ms === 2000);
      expect(index).toBeGreaterThanOrEqual(0);
      const id = set.mock.results[index]?.value;
      unmount();
      expect(clear).toHaveBeenCalledWith(id);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  it("renames optimistically and rolls back when the PUT fails", async () => {
    const user = userEvent.setup();
    const held = hold((m) => m === "PUT");
    const fetch = fakeServer({ packages: [LAMP], handler: held.handler });
    renderPages("/app/p/p1", routes, fetch);

    await user.click(await screen.findByRole("button", { name: "Desk lamp" }));
    const field = screen.getByRole("textbox", { name: "Title" });
    await user.clear(field);
    await user.type(field, "Reading lamp{Enter}");

    expect(screen.getByRole("heading", { level: 1, name: "Reading lamp" })).toBeInTheDocument();
    expect(writes(fetch)).toEqual([["PUT", "/packages/p1", { title: "Reading lamp" }]]);

    held.release({ status: 500, error: { code: "internal", message: "Something went wrong" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't rename this package. Try again.");
    expect(screen.getByRole("heading", { level: 1, name: "Desk lamp" })).toBeInTheDocument();
  });

  it("keeps the server's copy after a successful rename", async () => {
    const user = userEvent.setup();
    const handler: Handler = (m, _p, body) =>
      m === "PUT" ? { status: 200, data: { ...LAMP, title: (body as { title: string }).title, updatedAt: "2026-11-08T18:00:00.000Z" } } : undefined;
    renderPages("/app/p/p1", routes, fakeServer({ packages: [LAMP], handler }));
    await user.click(await screen.findByRole("button", { name: "Desk lamp" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), " 2{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Desk lamp 2" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancels a rename with Escape without leaving the page", async () => {
    const user = userEvent.setup();
    const fetch = fakeServer({ packages: [LAMP] });
    renderPages("/app/p/p1", routes, fetch);
    await user.click(await screen.findByRole("button", { name: "Desk lamp" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "xyz{Escape}");
    expect(screen.getByRole("heading", { level: 1, name: "Desk lamp" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/p/p1");
    expect(writes(fetch)).toEqual([]);
  });

  it("shows the refresh limit from Retry-After and holds the button", async () => {
    const user = userEvent.setup();
    const handler: Handler = (m, path) =>
      m === "POST" && path === "/packages/p1/refresh"
        ? { status: 429, error: { code: "rate_limited", message: "Slow down" }, headers: { "retry-after": "95" } }
        : undefined;
    renderPages("/app/p/p1", routes, fakeServer({ packages: [LAMP], handler }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Checked recently. Try again in 2 min.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("confirms a queued refresh", async () => {
    const user = userEvent.setup();
    const handler: Handler = (m) => (m === "POST" ? { status: 202, data: { queued: true, nextAllowedAt: "2026-11-08T18:02:00.000Z" } } : undefined);
    renderPages("/app/p/p1", routes, fakeServer({ packages: [LAMP], handler }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/^Asked UPS for an update\./)).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("archives at once and sends archived: true", async () => {
    const user = userEvent.setup();
    const held = hold((m) => m === "PUT");
    const fetch = fakeServer({ packages: [LAMP], handler: held.handler });
    renderPages("/app/p/p1", routes, fetch);
    await user.click(await screen.findByRole("button", { name: "Archive" }));
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
    expect(writes(fetch)).toEqual([["PUT", "/packages/p1", { archived: true }]]);
    held.release({ status: 200, data: { ...LAMP, archivedAt: "2026-11-08T18:00:00.000Z" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Unarchive" })).toBeEnabled());
  });

  it("deletes after confirming, and brings the package back if the server refuses", async () => {
    const user = userEvent.setup();
    const held = hold((m) => m === "DELETE");
    const fetch = fakeServer({ packages: [LAMP], handler: held.handler });
    renderPages("/app/p/p1", routes, fetch);

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const sheet = screen.getByRole("dialog", { name: "Delete this package?" });
    await user.click(within(sheet).getByRole("button", { name: "Delete" }));

    expect(screen.getByTestId("where")).toHaveTextContent(/^\/app$/);
    expect(writes(fetch)).toEqual([["DELETE", "/packages/p1", undefined]]);
    await waitFor(() => expect(screen.queryByText("Desk lamp")).not.toBeInTheDocument());

    held.release({ status: 500, error: { code: "internal", message: "Something went wrong" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't delete Desk lamp. It's back in your list.");
    expect(screen.getByText("Desk lamp")).toBeInTheDocument();
  });

  it("removes the package for good when the delete succeeds", async () => {
    const user = userEvent.setup();
    const handler: Handler = (m) => (m === "DELETE" ? { status: 200, data: { id: "p1", deletedAt: "2026-11-08T18:00:00.000Z" } } : undefined);
    renderPages("/app/p/p1", routes, fakeServer({ packages: [LAMP, pkg("p2", { title: "Socks" })], handler }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await screen.findByText("Socks");
    expect(screen.queryByText("Desk lamp")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("goes back to the list with Escape", async () => {
    const user = userEvent.setup();
    renderPages("/app/p/p1", routes, fakeServer({ packages: [LAMP] }));
    await screen.findByRole("heading", { level: 1, name: "Desk lamp" });
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/app$/);
  });

  it("explains an unknown id and a package with no scans", async () => {
    renderPages("/app/p/missing", routes, fakeServer({ packages: [LAMP] }));
    expect(await screen.findByRole("heading", { name: "This package isn't here" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to packages" })).toHaveAttribute("href", "/app");
  });

  it("says when the carrier has no scans or date yet", async () => {
    renderPages("/app/p/p9", routes, fakeServer({ packages: [pkg("p9", { carrier: "fedex", trackingNumber: "986578788855" })] }));
    expect(await screen.findByRole("heading", { name: "No scans yet" })).toBeInTheDocument();
    expect(screen.getByText("FedEx hasn't reported this number. Porchlight checks again within the hour.")).toBeInTheDocument();
    expect(screen.getByText("No delivery date from FedEx yet")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "FedEx ···8855" })).toBeInTheDocument();
  });
});
