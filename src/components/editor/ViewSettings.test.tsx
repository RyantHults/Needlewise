import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChartPresentationMode } from "../../editor";
import { CanvasControls } from "./CanvasControls";
import { ViewSettings } from "./ViewSettings";

describe("ViewSettings", () => {
  it("marks the current mode pressed and calls back for modes and Render", () => {
    const onChartMode = vi.fn();
    const onThreadView = vi.fn();
    render(<ViewSettings mode={ChartPresentationMode.Symbol} threadView={false} onChartMode={onChartMode} onThreadView={onThreadView} />);
    expect(screen.getByRole("button", { name: "Symbol" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Color" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Render" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "B/W" }));
    expect(onChartMode).toHaveBeenCalledWith(ChartPresentationMode.Grayscale);
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    expect(onThreadView).toHaveBeenCalledTimes(1);
  });

  it("presses only Render while thread view is on", () => {
    render(<ViewSettings mode={ChartPresentationMode.Color} threadView onChartMode={vi.fn()} onThreadView={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Render" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Color" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("CanvasControls", () => {
  it("sends the zoom keys", () => {
    const onCommand = vi.fn();
    render(<CanvasControls onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(onCommand.mock.calls.map(([key]) => key)).toEqual(["+", "-", "0"]);
  });
});
