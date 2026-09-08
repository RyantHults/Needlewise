import {
  DEFAULT_LOD_THRESHOLDS,
  RenderLod,
  type CanvasMetrics,
  type DocumentSize,
  type LodThresholds,
  type ScreenPoint,
  type Viewport
} from './contracts';
import {
  clampViewport,
  fitViewport,
  visibleCellRect,
  zoomAt,
  zoomBy,
  type ViewportClampOptions
} from './coordinates';

export interface ViewportOptions extends ViewportClampOptions {
  readonly thresholds?: Partial<LodThresholds>;
}

export function resolveLodThresholds(thresholds: Partial<LodThresholds> = {}): LodThresholds {
  const overviewMaxZoom = Number.isFinite(thresholds.overviewMaxZoom)
    ? Math.max(0, thresholds.overviewMaxZoom as number)
    : DEFAULT_LOD_THRESHOLDS.overviewMaxZoom;
  const compactMaxZoom = Number.isFinite(thresholds.compactMaxZoom)
    ? Math.max(overviewMaxZoom, thresholds.compactMaxZoom as number)
    : Math.max(overviewMaxZoom, DEFAULT_LOD_THRESHOLDS.compactMaxZoom);
  return { overviewMaxZoom, compactMaxZoom };
}

export function getRenderLod(zoom: number, thresholds: Partial<LodThresholds> = {}): RenderLod {
  const resolved = resolveLodThresholds(thresholds);
  if (zoom < resolved.overviewMaxZoom) return RenderLod.Overview;
  if (zoom < resolved.compactMaxZoom) return RenderLod.Compact;
  return RenderLod.Detail;
}

export const lodForZoom = getRenderLod;
export const levelOfDetail = getRenderLod;
export const getLod = getRenderLod;
export const selectLod = getRenderLod;

export function createViewport(
  documentSize: DocumentSize,
  metrics: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight'>,
  options: ViewportOptions = {}
): Viewport {
  return fitViewport(documentSize, metrics, 0, options);
}

export function fitToViewport(
  documentSize: DocumentSize,
  metrics: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight'>,
  padding = 0,
  options: ViewportOptions = {}
): Viewport {
  return fitViewport(documentSize, metrics, padding, options);
}

/** Pan by screen pixels without changing zoom. */
export function panViewport(viewport: Viewport, delta: ScreenPoint): Viewport {
  const zoom = viewport.zoom > 0 && Number.isFinite(viewport.zoom) ? viewport.zoom : 1;
  return {
    x: viewport.x - delta.x / zoom,
    y: viewport.y - delta.y / zoom,
    zoom
  };
}

export function constrainViewport(
  viewport: Viewport,
  documentSize: DocumentSize,
  metrics: Pick<CanvasMetrics, 'cssWidth' | 'cssHeight'>,
  options: ViewportOptions = {}
): Viewport {
  return clampViewport(viewport, documentSize, metrics, options);
}

export { clampViewport, visibleCellRect, zoomAt, zoomBy };
