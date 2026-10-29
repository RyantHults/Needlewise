import { useEffect, useId, useRef, useState } from 'react';
import { PROJECT_THUMBNAIL_MAX_AXIS, PROJECT_THUMBNAIL_MAX_BACKSTITCHES, type ProjectThumbnailSummary } from '../persistence';
import type { CanvasContextAdapter } from '../editor/contracts';
import { parseHexColor, type Rgb } from '../domain/color';
import { isRecord } from '../domain/guards';
import { drawThreadBackstitch, THREAD_BACKSTITCH_WIDTH, THREAD_MIN_DETAIL_CELL_PX } from '../rendering/thread-preview';

interface Props {
  revision?: number;
  width?: number;
  height?: number;
  thumbnail?: ProjectThumbnailSummary;
}

const MAX_SAMPLE_CELLS = PROJECT_THUMBNAIL_MAX_AXIS * PROJECT_THUMBNAIL_MAX_AXIS;
const FIXED_UNITS_PER_CELL = 4;
const colorPattern = /^#[\da-f]{6}$/i;

function colorValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !colorPattern.test(value)) return null;
  return value;
}

function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && (Object.getPrototypeOf(value) === Array.prototype || Object.getPrototypeOf(value) === null);
}

function isUsableThumbnail(value: ProjectThumbnailSummary | undefined): value is ProjectThumbnailSummary {
  if (!value || value.version !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
  if (!Number.isSafeInteger(value.columns) || !Number.isSafeInteger(value.rows) || value.columns < 1 || value.rows < 1) return false;
  if (value.columns > PROJECT_THUMBNAIL_MAX_AXIS || value.rows > PROJECT_THUMBNAIL_MAX_AXIS || value.columns * value.rows > MAX_SAMPLE_CELLS) return false;
  if (!isPlainArray(value.palette) || value.palette.length < 1 || !value.palette.every((entry, index) => (entry === null ? index > 0 : Boolean(colorValue(entry))))) return false;
  const { indices } = value;
  const expectedTag = value.palette.length <= 256 ? '[object Uint8Array]' : '[object Uint16Array]';
  if (!ArrayBuffer.isView(indices) || Object.prototype.toString.call(indices) !== expectedTag || indices.length !== value.columns * value.rows) return false;
  for (let index = 0; index < indices.length; index += 1) {
    if (indices[index] >= value.palette.length) return false;
  }
  const { backstitches } = value;
  if (backstitches === undefined) return true;
  if (!isRecord(backstitches)) return false;
  const { points, colors: segmentColors } = backstitches;
  if (!ArrayBuffer.isView(points) || Object.prototype.toString.call(points) !== '[object Uint32Array]' || points.length % 4 !== 0) return false;
  const segments = points.length / 4;
  if (segments > PROJECT_THUMBNAIL_MAX_BACKSTITCHES) return false;
  if (!ArrayBuffer.isView(segmentColors) || Object.prototype.toString.call(segmentColors) !== expectedTag || segmentColors.length !== segments) return false;
  for (let index = 0; index < segments; index += 1) {
    if (segmentColors[index] >= value.palette.length || value.palette[segmentColors[index]] === null) return false;
  }
  return true;
}

/** Stitch texture behind the canvas; it takes its colours from theme roles, so it follows the active theme. */
function StitchTexture() {
  const patternId = useId();
  const cross = (x1: number, y1: number, x2: number, y2: number) => (
    <>
      <path className="project-gallery-stitch-shadow" d={`M${x1 + 0.8} ${y1 + 0.8}L${x2 - 0.8} ${y2 - 0.8}`} strokeWidth="2.2" />
      <path className="project-gallery-stitch-thread" d={`M${x1 + 0.8} ${y1 + 0.8}L${x2 - 0.8} ${y2 - 0.8}`} strokeWidth="1.5" />
      <path className="project-gallery-stitch-highlight" d={`M${x1 + 0.4} ${y1 + 0.4}L${x2 - 1.2} ${y2 - 1.2}`} strokeWidth="0.5" />
      <path className="project-gallery-stitch-shadow" d={`M${x2 - 0.8} ${y1 + 0.8}L${x1 + 0.8} ${y2 - 0.8}`} strokeWidth="2.2" />
      <path className="project-gallery-stitch-thread" d={`M${x2 - 0.8} ${y1 + 0.8}L${x1 + 0.8} ${y2 - 0.8}`} strokeWidth="1.5" />
      <path className="project-gallery-stitch-highlight" d={`M${x2 - 1.2} ${y1 + 0.4}L${x1 + 0.4} ${y2 - 1.2}`} strokeWidth="0.5" />
    </>
  );
  return (
    <svg className="project-gallery-stitch-texture" aria-hidden="true">
      <defs>
        <pattern id={patternId} width="16" height="16" patternUnits="userSpaceOnUse">
          {cross(0, 0, 8, 8)}
          {cross(8, 8, 16, 16)}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}

function NeutralPreview() {
  return (
    <div className="project-gallery-neutral-preview" aria-hidden="true">
      <span className="project-gallery-neutral-mark">✣</span>
      <span className="project-gallery-neutral-stitches">× × · ×</span>
    </div>
  );
}

/** A deliberately display-only, bounded thumbnail. It never reads storage or derives a project document. */
export function ProjectThumbnail({ revision, width, height, thumbnail }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const usable = isUsableThumbnail(thumbnail)
    && (revision === undefined || thumbnail.revision === revision)
    && typeof width === 'number' && typeof height === 'number'
    && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;

  useEffect(() => {
    setDrawn(false);
    if (!usable || !thumbnail) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let cleanup: () => void = () => undefined;
    try {
      const frame = canvas.parentElement;
      const source = document.createElement('canvas');
      source.width = thumbnail.columns;
      source.height = thumbnail.rows;
      const sourceContext = source.getContext('2d');
      if (!sourceContext) return;
      const image = sourceContext.createImageData(thumbnail.columns, thumbnail.rows);
      const colors = thumbnail.palette.map((entry) => (entry === null ? null : parseHexColor(colorValue(entry) as string) as Rgb));
      for (let index = 0; index < thumbnail.indices.length; index += 1) {
        // A canvas hole stays transparent, as createImageData zero-fills.
        const color = colors[thumbnail.indices[index]];
        if (color === null) continue;
        const offset = index * 4;
        image.data[offset] = color[0];
        image.data[offset + 1] = color[1];
        image.data[offset + 2] = color[2];
        image.data[offset + 3] = 255;
      }
      sourceContext.putImageData(image, 0, 0);

      const paint = (cssWidth: number, cssHeight: number, ratio: number) => {
        canvas.width = Math.max(1, Math.round(cssWidth * ratio));
        canvas.height = Math.max(1, Math.round(cssHeight * ratio));
        context.imageSmoothingEnabled = false;
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const { backstitches } = thumbnail;
        if (!backstitches || backstitches.colors.length === 0) return;
        const cellPx = canvas.width / width!;
        const detailed = cellPx >= THREAD_MIN_DETAIL_CELL_PX;
        const cellUnit = 1 / FIXED_UNITS_PER_CELL;
        context.lineCap = 'round';
        context.lineWidth = Math.max(1, THREAD_BACKSTITCH_WIDTH * cellPx);
        for (let segment = 0; segment < backstitches.colors.length; segment += 1) {
          const at = segment * 4;
          const from = { x: backstitches.points[at] * cellUnit, y: backstitches.points[at + 1] * cellUnit };
          const to = { x: backstitches.points[at + 2] * cellUnit, y: backstitches.points[at + 3] * cellUnit };
          const color = thumbnail.palette[backstitches.colors[segment]] as string;
          if (detailed) {
            drawThreadBackstitch(context as unknown as CanvasContextAdapter, from, to, cellPx, color);
          } else {
            context.strokeStyle = color;
            context.beginPath();
            context.moveTo(from.x * cellPx, from.y * cellPx);
            context.lineTo(to.x * cellPx, to.y * cellPx);
            context.stroke();
          }
        }
      };
      let painted = false;
      const layout = () => {
        if (!frame) return;
        const bounds = frame.getBoundingClientRect();
        const frameWidth = bounds.width || frame.clientWidth;
        const frameHeight = bounds.height || frame.clientHeight;
        if (frameWidth <= 0 || frameHeight <= 0) return;
        const inset = Math.min(12, Math.min(frameWidth, frameHeight) * 0.08);
        const scale = Math.min((frameWidth - inset * 2) / width!, (frameHeight - inset * 2) / height!);
        const cssWidth = Math.max(1, Math.floor(width! * scale));
        const cssHeight = Math.max(1, Math.floor(height! * scale));
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        paint(cssWidth, cssHeight, window.devicePixelRatio || 1);
        painted = true;
      };
      layout();
      if (!painted) paint(width!, height!, 1);
      const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(layout);
      if (resizeObserver && frame) resizeObserver.observe(frame);
      window.addEventListener('resize', layout);
      cleanup = () => {
        resizeObserver?.disconnect();
        window.removeEventListener('resize', layout);
      };
      setDrawn(true);
    } catch {
      setDrawn(false);
      cleanup();
      return;
    }
    return cleanup;
  }, [height, revision, thumbnail, usable, width]);

  return <span className="project-gallery-thumbnail">
    <span className="project-gallery-thumbnail-fallback">
      <StitchTexture />
      {usable && drawn ? null : <NeutralPreview />}
    </span>
    {usable ? <canvas ref={canvasRef} className={drawn ? 'project-gallery-thumbnail-canvas' : 'project-gallery-thumbnail-canvas project-gallery-thumbnail-pending'} aria-hidden="true" /> : null}
  </span>;
}
