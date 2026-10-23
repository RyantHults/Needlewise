import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDismissable } from "./dismiss";
import { InfoTip } from "./InfoTip";
import { Modal } from "./Modal";

function Menu({ label, children, portal = false }: { label: string; children?: React.ReactNode; portal?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissable({ open, refs: [menu, trigger], onDismiss: () => setOpen(false), returnFocus: trigger });
  const body = open ? <div ref={menu} role="menu" aria-label={label}>{children}</div> : null;
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(!open)}>{`Open ${label}`}</button>
      {portal && body ? createPortal(body, document.body) : body}
    </>
  );
}

function openMenu(label: string) {
  fireEvent.click(screen.getByRole("button", { name: `Open ${label}` }));
  return screen.getByRole("menu", { name: label });
}

const nested = (
  <Menu label="Outer">
    <button type="button">Outer item</button>
    <Menu label="Inner" portal><button type="button">Inner item</button></Menu>
  </Menu>
);

describe("useDismissable", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes only the topmost overlay on each Escape", () => {
    render(nested);
    openMenu("Outer");
    openMenu("Inner");

    fireEvent.keyDown(screen.getByRole("button", { name: "Inner item" }), { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("menu", { name: "Outer" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Outer" })).toBeNull();
  });

  it("treats a press inside a portaled nested overlay as inside its parent", () => {
    render(nested);
    openMenu("Outer");
    const inner = openMenu("Inner");
    expect(inner.parentElement).toBe(document.body);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Inner item" }));
    expect(screen.getByRole("menu", { name: "Inner" })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Outer" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outer item" }));
    expect(screen.queryByRole("menu", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("menu", { name: "Outer" })).toBeInTheDocument();
  });

  it("closes on an outside press without moving focus or stopping the press", () => {
    render(<>{nested}<button type="button">Elsewhere</button><input aria-label="Field" /></>);
    openMenu("Outer");
    openMenu("Inner");
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    const field = screen.getByRole("textbox", { name: "Field" });
    field.focus();
    const reached = vi.fn();
    elsewhere.addEventListener("pointerdown", reached);

    fireEvent.pointerDown(elsewhere);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(reached).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field);
  });

  it("returns focus synchronously after Escape", () => {
    render(nested);
    openMenu("Outer");
    const item = screen.getByRole("button", { name: "Outer item" });
    item.focus();

    fireEvent.keyDown(item, { key: "Escape" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Outer" }));
  });

  it("hides a consumed Escape from window listeners, then lets it through once nothing is open", () => {
    render(nested);
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    openMenu("Outer");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(behind).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", behind);
    expect(behind).toHaveBeenCalledTimes(1);
  });

  it("closes an InfoTip inside a Modal before the Modal", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Modal title="Settings" onClose={onClose}><InfoTip label="Help">Text</InfoTip></Modal>);
    const button = screen.getByRole("button", { name: "Help" });
    fireEvent.click(button);
    const tip = screen.getByRole("tooltip", { hidden: true });

    fireEvent.keyDown(button, { key: "Escape" });
    expect(tip).toHaveAttribute("data-open", "false");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(button, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps an overlay beneath a Modal open while the Modal is pressed", () => {
    vi.useFakeTimers();
    function Harness() {
      const [modal, setModal] = useState(false);
      return (
        <>
          <Menu label="Dock"><button type="button" onClick={() => setModal(true)}>Manage</button></Menu>
          {modal ? <Modal title="Manager" onClose={() => setModal(false)}><button type="button">Inside</button></Modal> : null}
        </>
      );
    }
    render(<Harness />);
    openMenu("Dock");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    fireEvent.pointerDown(screen.getByRole("button", { name: "Inside" }));
    fireEvent.pointerDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(screen.getByRole("menu", { name: "Dock" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("menu", { name: "Dock" })).toBeInTheDocument();
  });

  it("leaves the stack when unmounted while open", () => {
    const onEscape = vi.fn();
    function Overlay() {
      const ref = useRef<HTMLDivElement>(null);
      useDismissable({ open: true, refs: [ref], onDismiss: onEscape });
      return <div ref={ref} />;
    }
    const { unmount } = render(<Overlay />);
    unmount();
    const behind = vi.fn();
    window.addEventListener("keydown", behind);

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    window.removeEventListener("keydown", behind);

    expect(onEscape).not.toHaveBeenCalled();
    expect(behind).toHaveBeenCalledTimes(1);
  });
});
