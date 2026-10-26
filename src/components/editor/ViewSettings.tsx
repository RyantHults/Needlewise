import { ChartPresentationMode } from "../../editor";
import { ActionButton } from "../controls/ActionButton";
import { Icon, type IconName } from "../controls/Icon";
import { ActionSection } from "./ActionSection";

const modes = [
  [ChartPresentationMode.Color, "Color", "color"],
  [ChartPresentationMode.Symbol, "Symbol", "symbol"],
  [ChartPresentationMode.Grayscale, "B/W", "grayscale"],
  [ChartPresentationMode.Combined, "Both", "shapes"],
] as const satisfies readonly (readonly [ChartPresentationMode, string, IconName])[];

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
        {modes.map(([v, l, icon]) => (
          <ActionButton
            key={v}
            glyph={<Icon name={icon} />}
            caption={l}
            title={l}
            aria-label={l}
            aria-pressed={mode === v && !threadView}
            onClick={() => onChartMode(v)}
          />
        ))}
        <ActionButton glyph={<Icon name="3d" />} caption="Render" title="Render" aria-label="Render" aria-pressed={threadView} onClick={onThreadView} />
      </div>
    </ActionSection>
  );
}
