import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createClient } from "../api/client";
import { fakeServer, makePackage } from "../packages/testing";
import { SessionProvider } from "../session";
import { PackagesProvider, usePackages, type PackagesValue } from "./packages";

let current: PackagesValue | null = null;

function Probe() {
  current = usePackages();
  return <output data-testid="ids">{current.packages.map((p) => p.id).join(",")}</output>;
}

describe("PackagesProvider", () => {
  it("runs a full sync straight away when the server rejects the cursor, and drops what the snapshot lacks", async () => {
    let full = 0;
    const fetch = fakeServer({
      handler: (_method, path) => {
        if (path === "/sync") {
          full++;
          const packages = full === 1 ? [makePackage("a"), makePackage("b")] : [makePackage("b")];
          return { status: 200, data: { packages, events: [], deleted: [], cursor: `full${full}`, hasMore: false } };
        }
        if (path.startsWith("/sync?since=")) return { status: 400, error: { code: "bad_request", message: "Unknown cursor" } };
        return undefined;
      },
    });
    render(
      <MemoryRouter>
        <SessionProvider client={createClient({ fetch })}>
          <PackagesProvider pollMs={3_600_000}>
            <Probe />
          </PackagesProvider>
        </SessionProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("ids")).toHaveTextContent("a,b"));

    await act(() => current!.sync());

    expect(screen.getByTestId("ids")).toHaveTextContent(/^b$/);
    expect(current!.error).toBeNull();
    const syncs = fetch.mock.calls.map(([input]) => String(input)).filter((u) => u.startsWith("/v1/sync"));
    expect(syncs).toEqual(["/v1/sync", "/v1/sync?since=full1", "/v1/sync"]);
  });
});
