import { ChartPresentationMode } from "../../editor";
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
          <button type="button" key={v} title={l} aria-label={l} aria-pressed={mode === v && !threadView} onClick={() => onChartMode(v)}>
            <span aria-hidden="true">{v === ChartPresentationMode.Color ? "◈" : v === ChartPresentationMode.Symbol ? "✣" : v === ChartPresentationMode.Grayscale ? "▧" : "◈✣"}</span><small>{l}</small>
          </button>
        ))}
        <button type="button" title="Render" aria-label="Render" aria-pressed={threadView} onClick={onThreadView}>
          <span aria-hidden="true">⨯</span><small>Render</small>
        </button>
      </div>
    </ActionSection>
  );
}
