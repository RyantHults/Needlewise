import { useEffect, useRef } from 'react';
import { contrastSymbolInk } from '../../rendering/contrast';
import { readThemeColor } from '../../rendering/theme-colors';
import { toSymbolOutline } from '../../symbols';
import type { ImportedChart, SymbolMapping } from '../../import/types';
import { mappingColor } from './mapping';

const MAX_PREVIEW_PX = 480;
const MAX_CELL_PX = 16;
/** Below this the mark is a smudge, so the cell shows its color alone. */
export const MIN_SYMBOL_CELL_PX = 8;

interface Props {
  chart: ImportedChart;
  mappings: readonly SymbolMapping[];
  /** symbolKey -> pool slug, as the created pattern will use. */
  slugs: ReadonlyMap<string, string>;
}

export function previewCellSize(chart: ImportedChart): number {
  return Math.max(1, Math.min(MAX_CELL_PX, Math.floor(MAX_PREVIEW_PX / Math.max(chart.width, chart.height, 1))));
}

export function ChartPreview({ chart, mappings, slugs }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cell = previewCellSize(chart);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = chart.width * cell;
    canvas.height = chart.height * cell;
    const context = canvas.getContext('2d');
    if (!context) return;
    const emptyCell = readThemeColor('--color-surface', '#fffdf9');
    const darkInk = readThemeColor('--color-ink', '#272321');
    context.fillStyle = emptyCell;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const byKey = new Map(mappings.map((mapping) => [mapping.symbolKey, mapping]));
    const looks = chart.symbols.map((symbol) => {
      const color = mappingColor(byKey.get(symbol.key)) ?? emptyCell;
      const slug = slugs.get(symbol.key);
      return { color, ink: contrastSymbolInk(color, darkInk), outline: slug ? toSymbolOutline(slug) : undefined };
    });
    for (let y = 0; y < chart.height; y += 1) {
      for (let x = 0; x < chart.width; x += 1) {
        const index = chart.cells[y * chart.width + x];
        if (index === 0) continue;
        const look = looks[index - 1];
        if (!look) continue;
        context.fillStyle = look.color;
        context.fillRect(x * cell, y * cell, cell, cell);
        if (cell >= MIN_SYMBOL_CELL_PX && look.outline) {
          context.save();
          context.translate((x + 0.5) * cell, (y + 0.5) * cell);
          context.scale(cell, cell);
          context.fillStyle = look.ink;
          context.fill(new Path2D(look.outline.d));
          context.restore();
        }
      }
    }
  }, [chart, mappings, slugs, cell]);
  return (
    <div className="import-preview-frame">
      <canvas ref={canvasRef} className="import-preview" role="img" aria-label={`Chart preview, ${chart.width} by ${chart.height} stitches`} />
    </div>
  );
}
