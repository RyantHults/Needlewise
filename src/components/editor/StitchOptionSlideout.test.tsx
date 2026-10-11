import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StitchOptionSlideout } from "./StitchOptionSlideout";

const OPTIONS = [
  { value: "/", label: "Bottom-left to top-right" },
  { value: "\\", label: "Top-left to bottom-right" },
] as const;

const setup = (active: boolean, value: "/" | "\\" = "/") => {
  const onChange = vi.fn();
  render(
    <StitchOptionSlideout active={active} groupLabel="Half stitch direction" options={OPTIONS} value={value} onChange={onChange}>
      <button type="button">Half stitch</button>
    </StitchOptionSlideout>,
  );
  return onChange;
};

describe("StitchOptionSlideout", () => {
  it("renders only the main button while inactive", () => {
    setup(false);
    expect(screen.getByRole("button", { name: "Half stitch" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Half stitch direction" })).toBeNull();
  });

  it("slides out the options beside the main button while active", () => {
    setup(true);
    const group = screen.getByRole("group", { name: "Half stitch direction" });
    expect(within(group).getAllByRole("button")).toHaveLength(2);
    expect(group.parentElement).toContainElement(screen.getByRole("button", { name: "Half stitch" }));
  });

  it("marks the selected option pressed and reports changes", () => {
    const onChange = setup(true, "\\");
    expect(screen.getByRole("button", { name: "Top-left to bottom-right" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bottom-left to top-right" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Bottom-left to top-right" }));
    expect(onChange).toHaveBeenCalledWith("/");
  });
});
