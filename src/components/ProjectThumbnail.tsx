import { useEffect, useRef, useState } from 'react';
import { PROJECT_THUMBNAIL_MAX_AXIS, type ProjectThumbnailSummary } from '../persistence';

interface Props {
  revision?: number;
  width?: number;
  height?: number;
  thumbnail?: ProjectThumbnailSummary;
}

const MAX_SAMPLE_CELLS = PROJECT_THUMBNAIL_MAX_AXIS * PROJECT_THUMBNAIL_MAX_AXIS;
const fabricColor = '#f3eee5';
const colorPattern = /^#[\da-f]{6}$/;

function colorValue(value: string | undefined): string | null {
  if (typeof value !== 'string' || !colorPattern.test(value)) return null;
  return value;
}

function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && (Object.getPrototypeOf(value) === Array.prototype || Object.getPrototypeOf(value) === null);
}

function isUsableThumbnail(value: ProjectThumbnailSummary | undefined): value is ProjectThumbnailSummary {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
  if (!Number.isSafeInteger(value.columns) || !Number.isSafeInteger(value.rows) || value.columns < 1 || value.rows < 1) return false;
  if (value.columns > PROJECT_THUMBNAIL_MAX_AXIS || value.rows > PROJECT_THUMBNAIL_MAX_AXIS || value.columns * value.rows > MAX_SAMPLE_CELLS) return false;
  if (!isPlainArray(value.palette) || !isPlainArray(value.indices) || value.indices.length !== value.columns * value.rows) return false;
  if (value.palette.length < 1 || colorValue(value.palette[0]) !== fabricColor) return false;
  return value.palette.every((entry) => Boolean(colorValue(entry)))
    && value.indices.every((index) => Number.isInteger(index) && index >= 0 && index < value.palette.length);
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
      canvas.width = thumbnail.columns;
      canvas.height = thumbnail.rows;
      const frame = canvas.parentElement;
      const layout = () => {
        if (!frame) return;
        const bounds = frame.getBoundingClientRect();
        const frameWidth = bounds.width || frame.clientWidth;
        const frameHeight = bounds.height || frame.clientHeight;
        if (frameWidth <= 0 || frameHeight <= 0) return;
        const scale = Math.min(frameWidth / thumbnail.columns, frameHeight / thumbnail.rows);
        canvas.style.width = `${Math.max(1, Math.floor(thumbnail.columns * scale))}px`;
        canvas.style.height = `${Math.max(1, Math.floor(thumbnail.rows * scale))}px`;
      };
      layout();
      const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(layout);
      if (resizeObserver && frame) resizeObserver.observe(frame);
      window.addEventListener('resize', layout);
      cleanup = () => {
        resizeObserver?.disconnect();
        window.removeEventListener('resize', layout);
      };
      context.imageSmoothingEnabled = false;
      const image = context.createImageData(thumbnail.columns, thumbnail.rows);
      const colors = thumbnail.palette.map((entry) => colorValue(entry) as string);
      for (let index = 0; index < thumbnail.indices.length; index += 1) {
        const hex = colors[thumbnail.indices[index]];
        const value = hex.slice(1);
        const offset = index * 4;
        image.data[offset] = parseInt(value.slice(0, 2), 16);
        image.data[offset + 1] = parseInt(value.slice(2, 4), 16);
        image.data[offset + 2] = parseInt(value.slice(4, 6), 16);
        image.data[offset + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      setDrawn(true);
    } catch {
      setDrawn(false);
      cleanup();
      return;
    }
    return cleanup;
  }, [height, revision, thumbnail, usable, width]);

  return <span className="project-gallery-thumbnail">
    {usable ? <>
      <span className="project-gallery-thumbnail-fallback"><NeutralPreview /></span>
      <canvas ref={canvasRef} className={drawn ? 'project-gallery-thumbnail-canvas' : 'project-gallery-thumbnail-canvas project-gallery-thumbnail-pending'} aria-hidden="true" />
    </> : <NeutralPreview />}
  </span>;
}
