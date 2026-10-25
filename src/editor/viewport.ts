import {
  DEFAULT_LOD_THRESHOLDS,
  RenderLod,
  type LodThresholds
} from './contracts';

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
