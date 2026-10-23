import { ActionButton } from "../controls/ActionButton";
import { ActionSection } from "./ActionSection";

interface Props {
  onCommand: (key: "+" | "-" | "0") => void;
}

export function CanvasControls({ onCommand }: Props) {
  return (
    <ActionSection id="canvas-actions-label" label="Canvas controls" className="canvas-actions-group">
      <ActionButton className="bottom-control" glyph="+" caption="In" onClick={() => onCommand("+")} aria-label="Zoom in" title="Zoom in" />
      <ActionButton className="bottom-control" glyph="−" caption="Out" onClick={() => onCommand("-")} aria-label="Zoom out" title="Zoom out" />
      <ActionButton className="bottom-control" glyph="⌖" caption="Fit" onClick={() => onCommand("0")} aria-label="Fit" title="Fit canvas" />
    </ActionSection>
  );
}
