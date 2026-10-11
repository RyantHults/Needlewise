import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PatternHeader } from "./PatternHeader";

function setup(overrides: Partial<Parameters<typeof PatternHeader>[0]> = {}) {
  const props = {
    titleId: "pattern-title",
    title: "Sampler",
    view: "track" as const,
    undo: { label: "Undo mark", onClick: vi.fn() },
    redo: { label: "Redo mark", disabled: true, onClick: vi.fn() },
    onExport: vi.fn(),
    onSettings: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
  render(<PatternHeader {...props} />);
  return props;
}

describe("PatternHeader", () => {
  it("wires history, export, settings, and navigation", () => {
    const props = setup({ info: <p>10 x 10</p> });
    fireEvent.click(screen.getByRole("button", { name: "Undo mark" }));
    expect(props.undo.onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Redo mark" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Export pattern" }));
    expect(props.onExport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(props.onSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(props.onNavigate).toHaveBeenCalledWith("edit");
    expect(screen.getByText("10 x 10")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Needlewise home" })).toBeInTheDocument();
  });

  it("renders a plain heading without onRenameTitle", () => {
    setup();
    expect(screen.getByRole("heading", { level: 2, name: "Sampler" })).toHaveAttribute("id", "pattern-title");
  });

  it("renames through the editable title", () => {
    const onRenameTitle = vi.fn();
    setup({ onRenameTitle });
    fireEvent.click(screen.getByRole("button", { name: "Rename Sampler" }));
    const input = screen.getByLabelText("Rename pattern Sampler");
    fireEvent.change(input, { target: { value: "Quilt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameTitle).toHaveBeenCalledWith("Quilt");
  });
});
