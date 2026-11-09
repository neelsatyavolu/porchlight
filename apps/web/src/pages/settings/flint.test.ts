import { describe, expect, it } from "vitest";
import { FLINT_DOWNLOAD_URL, flintPairLink } from "./flint";

describe("flintPairLink", () => {
  it("puts the code and the Porchlight host in a flint: link", () => {
    expect(flintPairLink("ABCD-EFGH", "porchlight.xanom.co")).toBe("flint://porchlight/pair?code=ABCD-EFGH&host=porchlight.xanom.co");
  });

  it("encodes both values", () => {
    expect(flintPairLink("A B&C", "localhost:5173")).toBe("flint://porchlight/pair?code=A%20B%26C&host=localhost%3A5173");
  });

  it("points people without Flint at its site", () => {
    expect(FLINT_DOWNLOAD_URL).toBe("https://flint.xanom.co");
  });
});
