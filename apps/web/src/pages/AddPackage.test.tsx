import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { PackagePutRequest } from "../api/types";
import { fakeServer, makePackage as pkg, renderPages, writes, type Handler } from "../packages/testing";
import { AddPackage } from "./AddPackage";
import { PackageDetail } from "./PackageDetail";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const routes = (
  <>
    <Route path="/app/add" element={<AddPackage />} />
    <Route path="/app/p/:id" element={<PackageDetail />} />
  </>
);

/** Answers each PUT by creating the package it describes. */
const creates: Handler = (method, path, body) => {
  if (method !== "PUT") return undefined;
  const id = path.split("/").pop() ?? "";
  const b = body as PackagePutRequest;
  return { status: 201, data: pkg(id, { trackingNumber: b.trackingNumber, carrier: b.carrier ?? "other", title: b.title ?? null }) };
};

function numbersField() {
  return screen.getByRole("textbox", { name: "Tracking number" });
}

describe("AddPackage", () => {
  it("detects the carrier, PUTs with a client UUID and opens the new package", async () => {
    const user = userEvent.setup();
    const fetch = fakeServer({ handler: creates });
    renderPages("/app/add", routes, fetch);

    expect(numbersField()).toHaveFocus();
    await user.type(numbersField(), "1z999aa10123456784");
    expect(screen.getByRole("radio", { name: "UPS" })).toBeChecked();
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Headphones");
    await user.click(screen.getByRole("button", { name: "Track package" }));

    const [put] = writes(fetch);
    expect(put?.[0]).toBe("PUT");
    const id = put?.[1].replace("/packages/", "") ?? "";
    expect(id).toMatch(UUID);
    expect(put?.[2]).toEqual({ trackingNumber: "1Z999AA10123456784", carrier: "ups", title: "Headphones", source: "manual" });
    expect(await screen.findByRole("heading", { level: 1, name: "Headphones" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent(`/app/p/${id}`);
  });

  it("asks for a carrier when the number fits more than one", async () => {
    const user = userEvent.setup();
    const fetch = fakeServer({ handler: creates });
    renderPages("/app/add", routes, fetch);

    await user.type(numbersField(), "CN123456785US");
    expect(screen.getByText("This number fits more than one carrier. Pick one.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Track package" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a carrier for this number.");
    expect(writes(fetch)).toEqual([]);

    await user.click(screen.getByRole("radio", { name: "DHL eCommerce" }));
    await user.click(screen.getByRole("button", { name: "Track package" }));
    expect(writes(fetch)[0]?.[2]).toMatchObject({ trackingNumber: "CN123456785US", carrier: "dhl_ecommerce" });
  });

  it("lets the server pick when detection finds nothing", async () => {
    const user = userEvent.setup();
    const fetch = fakeServer({ handler: creates });
    renderPages("/app/add", routes, fetch);
    await user.type(numbersField(), "abc-123");
    expect(screen.getByText("Porchlight doesn't recognize this format. It will still try to track it.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Track package" }));
    expect(writes(fetch)[0]?.[2]).toEqual({ trackingNumber: "ABC123", source: "manual" });
  });

  it("goes to the existing package on a duplicate", async () => {
    const user = userEvent.setup();
    const existing = pkg("old", { title: "Headphones", trackingNumber: "1Z999AA10123456784" });
    const handler: Handler = (m) =>
      m === "PUT"
        ? { status: 409, error: { code: "conflict", message: "Already tracked", details: { reason: "duplicate", existingId: "old" } } }
        : undefined;
    renderPages("/app/add", routes, fakeServer({ packages: [existing], handler }));
    await user.type(numbersField(), "1Z999AA10123456784");
    await user.click(screen.getByRole("button", { name: "Track package" }));
    expect(await screen.findByText("You're already tracking this.")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/p/old");
  });

  it("takes a fresh id once when the first one was used by a deleted package", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const handler: Handler = (m, p, b) => {
      if (m !== "PUT") return undefined;
      calls += 1;
      return calls === 1 ? { status: 409, error: { code: "conflict", message: "Deleted", details: { reason: "deleted" } } } : creates(m, p, b);
    };
    const fetch = fakeServer({ handler });
    renderPages("/app/add", routes, fetch);
    await user.type(numbersField(), "1Z999AA10123456784");
    await user.click(screen.getByRole("button", { name: "Track package" }));
    await screen.findByRole("heading", { level: 1 });
    const [first, second] = writes(fetch);
    expect(first?.[1]).not.toBe(second?.[1]);
  });

  it("adds several numbers, one per line, and keeps the ones that failed", async () => {
    const user = userEvent.setup();
    const handler: Handler = (m, p, b) =>
      m === "PUT" && (b as PackagePutRequest).trackingNumber === "TBA123456789012"
        ? { status: 400, error: { code: "bad_request", message: "trackingNumber is not valid" } }
        : creates(m, p, b);
    const fetch = fakeServer({ handler });
    renderPages("/app/add", routes, fetch);

    await user.type(numbersField(), "1Z999AA10123456784{Enter}TBA123456789012");
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Track 2 packages" }));

    expect(writes(fetch).map((w) => (w[2] as PackagePutRequest).trackingNumber)).toEqual(["1Z999AA10123456784", "TBA123456789012"]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't add this number: trackingNumber is not valid");
    expect(numbersField()).toHaveValue("TBA123456789012");
    expect(screen.getByTestId("where")).toHaveTextContent("/app/add");
  });

  it("needs at least one number", async () => {
    const user = userEvent.setup();
    renderPages("/app/add", routes, fakeServer());
    await user.click(screen.getByRole("button", { name: "Track package" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Paste a tracking number.");
  });

  it("closes with Escape, even from the field", async () => {
    const user = userEvent.setup();
    renderPages("/app/add", routes, fakeServer());
    await user.type(numbersField(), "1Z{Escape}");
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/app$/);
  });
});
