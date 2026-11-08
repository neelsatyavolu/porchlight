import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Button, CarrierBadge, EmptyState, Input, Row, Sheet, SkeletonRows, StatusDot } from ".";

describe("Button", () => {
  it("defaults to type=button and disables itself while busy", () => {
    render(<Button busy>Save</Button>);
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveAttribute("type", "button");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });
});

describe("Input", () => {
  it("labels the field and wires the error to it", () => {
    render(<Input label="Tracking number" mono error="That doesn't look like a tracking number" />);
    const input = screen.getByLabelText("Tracking number");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("That doesn't look like a tracking number");
    expect(input.className).toContain("field__input--mono");
  });
});

describe("StatusDot", () => {
  it("names the status when shown alone", () => {
    render(<StatusDot status="out_for_delivery" />);
    expect(screen.getByRole("img", { name: "Out for delivery" })).toHaveAttribute("data-tone", "out");
  });

  it("shows a text label when asked", () => {
    render(<StatusDot status="delivered" withLabel />);
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });
});

describe("CarrierBadge", () => {
  it("shows the carrier name", () => {
    render(<CarrierBadge carrier="ups" />);
    expect(screen.getByText("UPS")).toBeInTheDocument();
  });
});

describe("Row", () => {
  it("renders a link row with its slots", () => {
    render(
      <MemoryRouter>
        <Row to="/app/p/1" title="Headphones" meta="In transit" trailing="Today" trailingMeta={<CarrierBadge carrier="fedex" />} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/app/p/1");
    expect(link).toHaveTextContent("Headphones");
    expect(link).toHaveTextContent("Today");
    expect(link).toHaveTextContent("FedEx");
  });

  it("renders a button row when given onClick", () => {
    const onClick = vi.fn();
    render(<Row title="Flint on MacBook" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("EmptyState", () => {
  it("uses a page heading for page-size states", () => {
    render(<EmptyState size="page" title="Nothing on the way" />);
    expect(screen.getByRole("heading", { level: 1, name: "Nothing on the way" })).toBeInTheDocument();
  });
});

describe("Sheet", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Sheet open={open} onClose={() => setOpen(false)} title="Add a package">
          <input aria-label="Number" />
        </Sheet>
      </>
    );
  }

  it("opens as a labelled modal, focuses inside, closes on Escape and restores focus", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);

    expect(screen.getByRole("dialog", { name: "Add a package" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Number")).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe("SkeletonRows", () => {
  it("announces loading once and draws the asked-for number of rows", () => {
    const { container } = render(<SkeletonRows count={4} label="Loading packages" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading packages");
    expect(container.querySelectorAll(".skeleton__row")).toHaveLength(4);
    expect(container.querySelectorAll(".skeleton__dot")).toHaveLength(4);
  });

  it("leaves the dots out for non-package rows", () => {
    const { container } = render(<SkeletonRows count={2} dots={false} />);
    expect(container.querySelectorAll(".skeleton__dot")).toHaveLength(0);
  });
});
