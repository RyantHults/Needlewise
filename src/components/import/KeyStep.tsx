import { useRef, useState } from 'react';
import { DMC_CATALOG_DEFINITION, getDmcColor } from '../../catalog';
import type { ImportColor, ImportedChart, MappingStatus, SymbolMapping } from '../../import/types';
import { ColorPickerModal } from '../ColorPickerModal';
import { InfoTip } from '../InfoTip';
import { mappingColor } from './mapping';

const STATUS_LABELS: Record<MappingStatus, string> = { matched: 'Matched', guessed: 'Guessed', unmapped: 'Unmapped' };
const IMPORT_CATALOGS = [DMC_CATALOG_DEFINITION];
const DETECTED_SYMBOL_INFO = 'The detected symbols are printed in the PDF and only tell its colors apart here. Needlewise assigns its own chart symbols when the pattern is created.';

export interface KeyRow {
  mapping: SymbolMapping;
  status: MappingStatus;
  reason?: string;
}

interface Props {
  chart: ImportedChart;
  rows: readonly KeyRow[];
  disabled: boolean;
  onChoose: (mapping: SymbolMapping) => void;
}

function detectedLabel(chart: ImportedChart, symbolKey: string): string {
  const entry = chart.key.find((candidate) => candidate.symbolKey === symbolKey);
  if (!entry?.code) return 'Not in key';
  const codes = entry.blendCodes && entry.blendCodes.length > 1 ? entry.blendCodes.join('+') : entry.code;
  return [entry.brand, codes].filter(Boolean).join(' ');
}

export function KeyStep({ chart, rows, disabled, onChoose }: Props) {
  const changeButtons = useRef(new Map<string, HTMLButtonElement>());
  const [pickerKey, setPickerKey] = useState<string | null>(null);
  const pickerIndex = chart.symbols.findIndex((symbol) => symbol.key === pickerKey);
  const pickerMapping = rows.find((row) => row.mapping.symbolKey === pickerKey)?.mapping;
  const pickerThread = pickerMapping?.catalogCode ? getDmcColor(pickerMapping.catalogCode) : undefined;
  const choose = (mapping: SymbolMapping) => {
    onChoose(mapping);
    setPickerKey(null);
  };
  return (
    <>
      <p className="control-note">
        Check that each symbol maps to the right DMC thread. Rows needing attention are highlighted.
        {/* The stacked phone layout hides the table head, so the symbol info moves up here. */}
        <span className="import-key-phone-info"> <InfoTip label="About the detected symbols">{DETECTED_SYMBOL_INFO}</InfoTip></span>
      </p>
      <div className="import-key-frame">
        <table className="import-key">
          <thead>
            <tr>
              <th scope="col" className="import-key-symbol">
                <span className="import-key-heading">Detected symbol <InfoTip label="Detected symbol information">{DETECTED_SYMBOL_INFO}</InfoTip></span>
              </th>
              <th scope="col">Key entry</th>
              <th scope="col">Stitches</th>
              <th scope="col">Assigned thread</th>
              <th scope="col">Status</th>
              <th scope="col"><span className="visually-hidden">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {chart.symbols.map((symbol, index) => {
              const row = rows.find((candidate) => candidate.mapping.symbolKey === symbol.key);
              if (!row) return null;
              const color = mappingColor(row.mapping);
              const thread = row.mapping.catalogCode ? getDmcColor(row.mapping.catalogCode) : undefined;
              const label = `symbol ${index + 1}`;
              return (
                <tr key={symbol.key} className="import-key-row" data-status={row.status}>
                  <td data-label="Detected symbol" className="import-key-symbol">
                    <svg className="import-glyph" viewBox="0 0 1 1" role="img" aria-label={`Source ${label}`}>
                      <path d={symbol.outlineD} fill="currentColor" />
                    </svg>
                  </td>
                  <td data-label="Key entry">{detectedLabel(chart, symbol.key)}</td>
                  <td data-label="Stitches">{symbol.count.toLocaleString()}</td>
                  <td data-label="Assigned thread">
                    <span className="import-key-match">
                      <span className="import-swatch" style={color ? { background: color } : undefined} aria-hidden="true" />
                      {thread ? `DMC ${thread.code} ${thread.name}` : color ? `Custom ${color}` : 'No thread'}
                    </span>
                  </td>
                  <td data-label="Status" className="import-key-status">
                    <span><strong>{STATUS_LABELS[row.status]}</strong>{row.reason ? `: ${row.reason}` : ''}</span>
                  </td>
                  <td className="import-key-action">
                    <button className="button button-secondary" type="button" ref={(node) => { if (node) changeButtons.current.set(symbol.key, node); else changeButtons.current.delete(symbol.key); }} disabled={disabled} onClick={() => setPickerKey(symbol.key)}>
                      Change<span className="visually-hidden"> thread for {label}</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pickerKey !== null && (
        <ColorPickerModal
          catalogs={IMPORT_CATALOGS}
          defaultCatalogId={DMC_CATALOG_DEFINITION.association.catalogId}
          initialColor={pickerThread}
          initialCustomHex={pickerMapping?.color}
          verb="Use"
          eyebrow="Import"
          title={`Choose thread for symbol ${pickerIndex + 1}`}
          returnFocus={{ current: changeButtons.current.get(pickerKey) ?? null }}
          onClose={() => setPickerKey(null)}
          onPickCatalogColor={(record) => choose({ symbolKey: pickerKey, catalogCode: record.code })}
          onPickCustomColor={(hex, match) => choose({ symbolKey: pickerKey, color: hex.toLowerCase() as ImportColor, ...(match ? { catalogCode: match.code } : {}) })}
          customActionLabel={(hex, match) => (match ? `Use ${match.name}` : hex ? `Use ${hex}` : 'Use custom color')}
        />
      )}
    </>
  );
}
