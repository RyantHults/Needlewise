import { ChartPresentationMode } from "../../editor";
import { ActionButton } from "../controls/ActionButton";
import { ActionSection } from "./ActionSection";

const modes = [
  [ChartPresentationMode.Color, "Color"],
  [ChartPresentationMode.Symbol, "Symbol"],
  [ChartPresentationMode.Grayscale, "B/W"],
  [ChartPresentationMode.Combined, "Both"],
] as const;

interface Props {
  mode: ChartPresentationMode | undefined;
  threadView: boolean;
  onChartMode: (mode: ChartPresentationMode) => void;
  onThreadView: () => void;
}

export function ViewSettings({ mode, threadView, onChartMode, onThreadView }: Props) {
  return (
    <ActionSection id="view-actions-label" label="View settings" className="view-actions">
      <div className="chart-view" role="group" aria-label="View settings">
        {modes.map(([v, l]) => (
          <ActionButton
            key={v}
            glyph={v === ChartPresentationMode.Color ? "◈" : v === ChartPresentationMode.Symbol ? "✣" : v === ChartPresentationMode.Grayscale ? "▧" : "◈✣"}
            caption={l}
            title={l}
            aria-label={l}
            aria-pressed={mode === v && !threadView}
            onClick={() => onChartMode(v)}
          />
        ))}
        <ActionButton glyph="⨯" caption="Render" title="Render" aria-label="Render" aria-pressed={threadView} onClick={onThreadView} />
      </div>
    </ActionSection>
  );
}
