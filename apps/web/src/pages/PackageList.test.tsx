import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { pending } from "../packages/pending";
import { fakeServer, makePackage as pkg, renderPages, writes, type Handler } from "../packages/testing";
import { PackageList } from "./PackageList";

afterEach(() => pending.reset());

const routes = <Route path="/app" element={<PackageList />} />;

const PACKAGES = [
  pkg("p1", {
    title: "Headphones",
    status: "out_for_delivery",
    statusDetail: "On vehicle, Oakland",
    lastCheckedAt: "2026-11-08T17:46:00.000Z",
  }),
  pkg("p2", { merchant: "IKEA", carrier: "fedex", etaEnd: "2026-11-09", etaDateOnly: true }),
  pkg("p3", { title: "Desk lamp", etaEnd: "2026-11-12", etaDateOnly: true }),
  pkg("p4", { title: "Socks", status: "delivered", deliveredAt: "2026-11-08T16:30:00.000Z" }),
  pkg("p5", { title: "Old phone case", archivedAt: "2026-11-01T00:00:00.000Z" }),
  pkg("p6", { title: "Broken box", status: "exception", statusDetail: "Address issue", etaEnd: "2026-11-08", etaDateOnly: true }),
];

function groupNamed(name: RegExp) {
  return screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;
}

describe("PackageList", () => {
  it("groups packages by arrival day with problems pinned to the top of their group", async () => {
    renderPages("/app", routes, fakeServer({ packages: PACKAGES }));
    await screen.findByRole("heading", { name: "Packages" });

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Today2", "Tomorrow1", "This week1", "Delivered1"]);

    const today = within(groupNamed(/^Today/)).getAllByRole("link");
    expect(today.map((l) => l.querySelector(".row__title")?.textContent)).toEqual(["Broken box", "Headphones"]);
    expect(today[0]).toHaveTextContent("Problem · Address issue");
    expect(today[1]).toHaveTextContent("Out for delivery · On vehicle, Oakland");
    expect(today[1]).toHaveTextContent("Checked 14 min ago");
    expect(today[1]).toHaveAttribute("href", "/app/p/p1");

    const tomorrow = within(groupNamed(/^Tomorrow/)).getByRole("link");
    expect(tomorrow).toHaveTextContent("IKEA");
    expect(tomorrow).toHaveTextContent("FedEx");
    expect(tomorrow).toHaveTextContent("Not checked yet");
    expect(within(groupNamed(/^This week/)).getByRole("link")).toHaveTextContent("Thursday");
    expect(within(groupNamed(/^Delivered/)).getByRole("link")).toHaveTextContent("Delivered 8:30 AM");
    expect(screen.queryByText("Old phone case")).not.toBeInTheDocument();
  });

  it("filters by search, focuses search with / and clears it with Escape", async () => {
    const user = userEvent.setup();
    renderPages("/app", routes, fakeServer({ packages: PACKAGES }));
    await screen.findByText("Headphones");

    await user.keyboard("/");
    const search = screen.getByRole("searchbox", { name: "Search packages" });
    expect(search).toHaveFocus();
    await user.keyboard("lamp");
    expect(screen.getAllByRole("link").map((l) => l.querySelector(".row__title")?.textContent)).toEqual(["Desk lamp"]);

    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(search).not.toHaveFocus();
    expect(screen.getAllByRole("link")).toHaveLength(5);

    await user.type(search, "nothing like this");
    expect(screen.getByRole("heading", { name: 'Nothing matches "nothing like this"' })).toBeInTheDocument();
  });

  it("opens the add page with n", async () => {
    const user = userEvent.setup();
    renderPages("/app", routes, fakeServer({ packages: PACKAGES }));
    await screen.findByText("Headphones");
    await user.keyboard("n");
    expect(screen.getByTestId("where")).toHaveTextContent("/app/add");
  });

  it("switches to archived packages", async () => {
    const user = userEvent.setup();
    renderPages("/app", routes, fakeServer({ packages: PACKAGES }));
    await screen.findByText("Headphones");
    await user.click(screen.getByRole("button", { name: "Archived 1" }));
    expect(screen.getAllByRole("link").map((l) => l.querySelector(".row__title")?.textContent)).toEqual(["Old phone case"]);
  });

  it("archives delivered packages at once and puts them back if the server refuses", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const handler: Handler = (method) =>
      method === "PUT"
        ? new Promise((resolve) => {
            release = () => resolve({ status: 500, error: { code: "internal", message: "Something went wrong" } });
          })
        : undefined;
    const fetch = fakeServer({ packages: PACKAGES, handler });
    renderPages("/app", routes, fetch);
    await screen.findByText("Socks");

    await user.click(screen.getByRole("button", { name: "Archive all" }));
    expect(screen.queryByText("Socks")).not.toBeInTheDocument();
    expect(writes(fetch)).toEqual([["PUT", "/packages/p4", { archived: true }]]);

    release();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't archive 1 package. Try again.");
    expect(screen.getByText("Socks")).toBeInTheDocument();
  });

  it("shows the empty state with an add button when nothing is tracked", async () => {
    const user = userEvent.setup();
    renderPages("/app", routes, fakeServer());
    await user.click(await screen.findByRole("button", { name: "Add a package" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/add");
  });

  it("offers a retry when the first sync fails", async () => {
    const handler: Handler = (_m, path) =>
      path.startsWith("/sync") ? { status: 500, error: { code: "internal", message: "Something went wrong" } } : undefined;
    renderPages("/app", routes, fakeServer({ handler }));
    expect(await screen.findByRole("heading", { name: "Couldn't reach Porchlight" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("hides a package while its delete is in flight and shows a rolled-back delete's note", async () => {
    pending.hide("p3");
    renderPages("/app", routes, fakeServer({ packages: PACKAGES }));
    await screen.findByText("Headphones");
    expect(screen.queryByText("Desk lamp")).not.toBeInTheDocument();

    pending.unhide("p3");
    pending.notify("Couldn't delete Desk lamp. It's back in your list.");
    await waitFor(() => expect(screen.getByText("Desk lamp")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't delete Desk lamp");
  });
});
