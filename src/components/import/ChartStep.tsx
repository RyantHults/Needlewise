import type { ImportAnalysis, SymbolMapping } from '../../import/types';
import { ChartPreview } from './ChartPreview';

interface Props {
  colorLimit: number;
  analysis: ImportAnalysis;
  mappings: readonly SymbolMapping[];
  slugs: ReadonlyMap<string, string>;
}

export function ChartStep({ colorLimit, analysis, mappings, slugs }: Props) {
  const { chart } = analysis;
  const hasChart = chart.width > 0 && chart.height > 0;
  return (
    <>
      <p className="control-note" role="status">
        {hasChart ? `${chart.width} × ${chart.height} stitches, ${chart.symbols.length} symbols.` : 'No chart pages are selected.'}
      </p>
      {chart.symbols.length > colorLimit && <p className="modal-error" role="status">This chart uses {chart.symbols.length} colors, but at most {colorLimit} are supported, so it cannot be created.</p>}
      {hasChart && <ChartPreview chart={chart} mappings={mappings} slugs={slugs} />}
      {chart.warnings.length > 0 && (
        <section aria-labelledby="import-warnings-title">
          <h4 id="import-warnings-title">Warnings ({chart.warnings.length})</h4>
          <ul className="import-warnings">
            {chart.warnings.map((warning, index) => (
              <li key={index}>{warning.message}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
