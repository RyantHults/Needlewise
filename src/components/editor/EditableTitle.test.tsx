import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditableTitle } from "./EditableTitle";

function open(onCommit = vi.fn()) {
  render(<EditableTitle value="Sampler" onCommit={onCommit} headingId="title" />);
  fireEvent.click(screen.getByRole("button", { name: "Rename Sampler" }));
  return { onCommit, input: screen.getByLabelText("Rename pattern Sampler") as HTMLInputElement };
}

describe("EditableTitle", () => {
  it("renders the title as a heading button", () => {
    render(<EditableTitle value="Sampler" onCommit={vi.fn()} headingId="title" />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveAttribute("id", "title");
    expect(within(heading).getByRole("button", { name: "Rename Sampler" })).toHaveTextContent("Sampler");
  });

  it("commits a trimmed title on Enter and not again on blur", () => {
    const { onCommit, input } = open();
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "  Quilt  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Quilt");
    expect(screen.getByRole("button", { name: "Rename Sampler" })).toBeInTheDocument();
  });

  it("commits on blur", () => {
    const { onCommit, input } = open();
    fireEvent.change(input, { target: { value: "Quilt" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("Quilt");
  });

  it("cancels on Escape", () => {
    const { onCommit, input } = open();
    fireEvent.change(input, { target: { value: "Quilt" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores empty and unchanged titles", () => {
    const first = open();
    fireEvent.change(first.input, { target: { value: "   " } });
    fireEvent.keyDown(first.input, { key: "Enter" });
    expect(first.onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rename Sampler" }));
    fireEvent.keyDown(screen.getByLabelText("Rename pattern Sampler"), { key: "Enter" });
    expect(first.onCommit).not.toHaveBeenCalled();
  });
});
