import { useObjectUrl } from '../object-url';
import type { ImportAnalysis, ImportPageRole } from '../../import/types';

const ROLE_LABELS: Record<ImportPageRole, string> = { chart: 'Chart', key: 'Key', other: 'Ignore' };

interface Props {
  analysis: ImportAnalysis;
  disabled: boolean;
  onRole: (page: number, role: ImportPageRole) => void;
}

/** The page render, shown through an object URL. */
function PageThumbnail({ blob, page }: { blob: Blob | undefined; page: number }) {
  const url = useObjectUrl(blob);
  return (
    <div className="import-page-thumb">
      {blob && url ? <img src={url} alt={`Page ${page} preview`} /> : <span className="import-page-thumb-empty" aria-hidden="true">{page}</span>}
    </div>
  );
}

export function PagesStep({ analysis, disabled, onRole }: Props) {
  return (
    <>
      <p className="control-note">Check each page and mark it as part of the chart, as the thread key, or ignore it. Changing a page re-reads the pattern.</p>
      <ul className="import-pages">
        {analysis.pages.map((page) => (
          <li key={page.index} className="import-page">
            <PageThumbnail blob={page.thumbnail} page={page.index + 1} />
            <div className="import-page-info">
              <strong>Page {page.index + 1}</strong>
              <span>
                {page.grid ? `${page.grid.columns} × ${page.grid.rows} cells` : 'No chart grid'}
                {page.role !== page.detectedRole ? ' · changed' : ''}
              </span>
              <label>
                <span className="visually-hidden">Role of page {page.index + 1}</span>
                <select value={page.role} disabled={disabled} onChange={(event) => onRole(page.index, event.target.value as ImportPageRole)}>
                  {(Object.keys(ROLE_LABELS) as ImportPageRole[]).map((role) => (
                    <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                  ))}
                </select>
              </label>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
