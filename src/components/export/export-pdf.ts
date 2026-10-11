import type { ProjectWorkspace } from '../../application/workspace';
import { computePatternMetrics } from '../../domain';
import type { PatternDocument } from '../../domain';
import { renderCoverPng } from '../../export/cover-image';
import { startPdfExport } from '../../export/pdf-export-client';
import { patternBackgroundColor } from '../../rendering/atlas';
import type { ExportPdf } from './ExportPanel';

/**
 * The export panel's `exportPdf`, bound to the pattern's flattened composite.
 * Metrics and units are read when the export starts, so a material setting
 * saved in the panel is the one the PDF uses. Only kinds, colors, backstitch
 * geometry and the palette reach the writer; completion never does.
 */
export function createExportPdf(
  document: PatternDocument,
  workspace: Pick<ProjectWorkspace, 'metadata' | 'materialSettings'>,
  title: string
): ExportPdf {
  return async (settings, { signal, onProgress }) => {
    const metrics = computePatternMetrics(document, workspace.materialSettings ?? undefined);
    const pdfDocument = {
      width: document.width,
      height: document.height,
      kind: document.kind,
      colors: document.colors,
      backstitches: document.backstitches,
      palette: document.palette,
      ...(document.canvasMask ? { canvasMask: document.canvasMask } : {})
    };
    let coverImagePng: Uint8Array | undefined;
    try {
      coverImagePng = await renderCoverPng({ document: pdfDocument, backgroundColor: patternBackgroundColor(document) }, { signal });
    } catch (error) {
      // The cover is optional; only a cancellation stops the export.
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    }
    const job = startPdfExport(
      {
        document: pdfDocument,
        metrics,
        settings,
        units: workspace.metadata?.units ?? 'metric',
        name: title,
        ...(coverImagePng ? { coverImagePng } : {})
      },
      { signal, onProgress: ({ completed, total }) => onProgress(total > 0 ? completed / total : 0) }
    );
    return job.promise;
  };
}
