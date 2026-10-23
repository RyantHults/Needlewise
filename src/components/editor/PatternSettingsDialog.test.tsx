import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PatternSettingsDialog } from "./PatternSettingsDialog";
import { defaultEditorPreferences } from "./editor-preferences";

function setup(editorOptions: "all" | "placement" = "all", updateActiveMetadata = vi.fn().mockResolvedValue(undefined)) {
  const workspace = {
    metadata: { id: "p1", title: "Rose", notes: "n", units: "metric" },
    updateActiveMetadata,
  } as never;
  const onClose = vi.fn();
  const onPreferencesChange = vi.fn();
  render(
    <PatternSettingsDialog
      workspace={workspace}
      preferences={defaultEditorPreferences()}
      onPreferencesChange={onPreferencesChange}
      editorOptions={editorOptions}
      onClose={onClose}
    />,
  );
  return { updateActiveMetadata, onClose, onPreferencesChange };
}

describe("PatternSettingsDialog", () => {
  it("saves a trimmed title, notes and units, then closes", async () => {
    const { updateActiveMetadata, onClose } = setup();
    expect(screen.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  Tulip  " } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateActiveMetadata).toHaveBeenCalledWith({ title: "Tulip", notes: "hello", units: "metric" });
  });

  it("falls back to the default title when blank", async () => {
    const { updateActiveMetadata, onClose } = setup();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateActiveMetadata).toHaveBeenCalledWith(expect.objectContaining({ title: "Untitled sampler" }));
  });

  it("applies units immediately", () => {
    const { updateActiveMetadata } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Imperial" }));
    expect(updateActiveMetadata).toHaveBeenCalledWith({ units: "imperial" });
    expect(screen.getByRole("button", { name: "Imperial" })).toHaveAttribute("aria-pressed", "true");
  });

  it("rolls units back when the update fails and ignores the current choice", async () => {
    const { updateActiveMetadata } = setup("all", vi.fn().mockRejectedValue(new Error("no")));
    fireEvent.click(screen.getByRole("button", { name: "Metric" }));
    expect(updateActiveMetadata).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Imperial" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Metric" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "Imperial" })).toHaveAttribute("aria-pressed", "false");
  });

  it("moves between tabs with End and Home", async () => {
    setup();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Project" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Editor" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Editor" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows every editor option in all mode", () => {
    setup("all");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.getByRole("group", { name: "Control placement" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Show palette symbols")).toBeNull();
    expect(screen.getByLabelText("Show palette numbers")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Enable pencil mode" })).toBeInTheDocument();
  });

  it("opens the pencil mode tip on click without toggling pencil mode", () => {
    const { onPreferencesChange } = setup("all");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    const info = screen.getByRole("button", { name: "Pencil mode information" });
    expect(info).toHaveAttribute("aria-describedby", "pencil-mode-tooltip");
    expect(info).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tooltip")).toHaveTextContent("only a pencil or stylus can make changes");
    expect(onPreferencesChange).not.toHaveBeenCalled();
  });

  it("shows only control placement in placement mode", () => {
    const { onPreferencesChange } = setup("placement");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.queryByLabelText("Show palette symbols")).toBeNull();
    expect(screen.queryByLabelText("Show palette numbers")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Enable pencil mode" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Left" }));
    const updater = onPreferencesChange.mock.calls[0]![0];
    expect(updater(defaultEditorPreferences()).railSide).toBe("left");
  });

  it("offers the center guides only in placement mode", () => {
    setup("all");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.queryByLabelText("Show center guides")).toBeNull();
  });

  it("toggles the center guides in placement mode", () => {
    const { onPreferencesChange } = setup("placement");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    const toggle = screen.getByLabelText("Show center guides");
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    const updater = onPreferencesChange.mock.calls[0]![0];
    expect(updater(defaultEditorPreferences()).showCenterMark).toBe(true);
  });

  it("moves between tabs with the arrow keys", async () => {
    setup();
    const project = screen.getByRole("tab", { name: "Project" });
    fireEvent.keyDown(project, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Editor" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Editor" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("tab", { name: "Editor" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
  });
});
