import type { ProjectWorkspace } from '../../application/workspace';
import { computePatternMetrics, cropToContent } from '../../domain';
import type { PatternDocument } from '../../domain';
import { renderCoverPng } from '../../export/cover-image';
import { startPdfExport } from '../../export/pdf-export-client';
import { patternBackgroundColor } from '../../rendering/atlas';
import type { ExportPdf } from './ExportPanel';

/**
 * The export panel's `exportPdf`, bound to the pattern's flattened composite.
 * Metrics and units are read when the export starts, so a material setting
 * saved in the panel is the one the PDF uses. With `autoCrop` the chart,
 * metrics and cover are built from the pattern cropped to its content. Only
 * kinds, colors, backstitch geometry and the palette reach the writer;
 * completion never does.
 */
export function createExportPdf(
  document: PatternDocument,
  workspace: Pick<ProjectWorkspace, 'metadata' | 'materialSettings'>,
  title: string
): ExportPdf {
  return async (settings, { signal, onProgress }) => {
    const source = settings.autoCrop ? cropToContent(document) : document;
    const metrics = computePatternMetrics(source, workspace.materialSettings ?? undefined);
    const pdfDocument = {
      width: source.width,
      height: source.height,
      kind: source.kind,
      colors: source.colors,
      backstitches: source.backstitches,
      palette: source.palette,
      ...(source.canvasMask ? { canvasMask: source.canvasMask } : {})
    };
    let coverImagePng: Uint8Array | undefined;
    try {
      coverImagePng = await renderCoverPng({ document: pdfDocument, backgroundColor: patternBackgroundColor(source) }, { signal });
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
