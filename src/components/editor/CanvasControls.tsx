import { ActionSection } from "./ActionSection";

interface Props {
  onCommand: (key: "+" | "-" | "0") => void;
}

export function CanvasControls({ onCommand }: Props) {
  return (
    <ActionSection id="canvas-actions-label" label="Canvas controls" className="canvas-actions-group">
      <button className="bottom-control" type="button" onClick={() => onCommand("+")} aria-label="Zoom in" title="Zoom in">
        <span aria-hidden="true">+</span><small>In</small>
      </button>
      <button className="bottom-control" type="button" onClick={() => onCommand("-")} aria-label="Zoom out" title="Zoom out">
        <span aria-hidden="true">−</span><small>Out</small>
      </button>
      <button className="bottom-control" type="button" onClick={() => onCommand("0")} aria-label="Fit" title="Fit canvas">
        <span aria-hidden="true">⌖</span><small>Fit</small>
      </button>
    </ActionSection>
  );
}
