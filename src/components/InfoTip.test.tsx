import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InfoTip } from "./InfoTip";

function setup() {
  const outerEscape = vi.fn();
  const view = render(
    <div onKeyDown={(event) => { if (event.key === "Escape") outerEscape(); }}>
      <InfoTip label="Thing information">Some help text.</InfoTip>
      <button type="button">Elsewhere</button>
    </div>,
  );
  const button = screen.getByRole("button", { name: "Thing information" });
  const tip = screen.getByRole("tooltip", { hidden: true });
  return { ...view, button, tip, outerEscape };
}

describe("InfoTip", () => {
  it("describes its button with the tooltip and starts closed", () => {
    const { button, tip } = setup();
    expect(button).toHaveAttribute("aria-describedby", tip.id);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(tip).toHaveAttribute("data-open", "false");
    expect(tip).toHaveTextContent("Some help text.");
  });

  it("opens on hover and focus, and closes on leave and blur", () => {
    const { button, tip } = setup();
    fireEvent.mouseEnter(button);
    expect(tip).toHaveAttribute("data-open", "true");
    fireEvent.mouseLeave(button);
    expect(tip).toHaveAttribute("data-open", "false");
    fireEvent.focus(button);
    expect(tip).toHaveAttribute("data-open", "true");
    fireEvent.blur(button);
    expect(tip).toHaveAttribute("data-open", "false");
  });

  it("toggles on click and stays open after the pointer leaves", () => {
    const { button, tip } = setup();
    fireEvent.mouseEnter(button);
    fireEvent.click(button);
    fireEvent.mouseLeave(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(tip).toHaveAttribute("data-open", "false");
  });

  it("closes on Escape without letting the key reach enclosing handlers", () => {
    const { button, tip, outerEscape } = setup();
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(tip).toHaveAttribute("data-open", "false");
    expect(outerEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(outerEscape).toHaveBeenCalledTimes(1);
  });

  it("closes on a press outside", () => {
    const { button, tip } = setup();
    fireEvent.click(button);
    fireEvent.pointerDown(tip);
    expect(tip).toHaveAttribute("data-open", "true");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(tip).toHaveAttribute("data-open", "false");
  });

  it("places the open tip under its button, inside the viewport", () => {
    const { button, tip } = setup();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ left: 2000, bottom: 40 } as DOMRect);
    fireEvent.click(button);
    expect(tip.style.top).toBe("48px");
    expect(Number.parseFloat(tip.style.left)).toBeLessThanOrEqual(window.innerWidth);
  });
});
