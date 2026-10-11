import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PatternSettingsDialog } from "./PatternSettingsDialog";
import { readEditorPreferences } from "./editor-preferences";

function setup(editorOptions: "all" | "placement" = "all") {
  const updateActiveMetadata = vi.fn().mockResolvedValue(undefined);
  const workspace = {
    metadata: { id: "p1", title: "Rose", notes: "n", units: "metric" },
    updateActiveMetadata,
  } as never;
  const onClose = vi.fn();
  const onPreferencesChange = vi.fn();
  render(
    <PatternSettingsDialog
      workspace={workspace}
      preferences={readEditorPreferences("p1")}
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

  it("shows every editor option in all mode", () => {
    setup("all");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.getByRole("group", { name: "Control placement" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Show palette symbols")).toBeNull();
    expect(screen.getByLabelText("Show palette numbers")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Enable pencil mode" })).toBeInTheDocument();
  });

  it("shows only control placement in placement mode", () => {
    const { onPreferencesChange } = setup("placement");
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.queryByLabelText("Show palette symbols")).toBeNull();
    expect(screen.queryByLabelText("Show palette numbers")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Enable pencil mode" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Left" }));
    const updater = onPreferencesChange.mock.calls[0]![0];
    expect(updater(readEditorPreferences("p1")).railSide).toBe("left");
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
