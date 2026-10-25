import type { CanvasContextAdapter } from '../editor/contracts';

export interface RecordingContext extends CanvasContextAdapter {
  calls: string[];
  imageSmoothingQuality: string;
  records: Array<{
    name: string;
    args: unknown[];
    fillStyle: string;
    strokeStyle: string;
    globalAlpha: number;
    lineWidth: number;
    font: string;
    textAlign: string;
  }>;
}

export function recordingContext(): RecordingContext {
  // Canvas save/restore also carries globalAlpha; the dim tests depend on it being restored.
  const alphaStack: number[] = [];
  const context: RecordingContext = {
    calls: [],
    records: [],
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    clearRect: function (this: RecordingContext, ...args: number[]): void { record(this, 'clearRect', args); },
    fillRect: function (this: RecordingContext, ...args: number[]): void { record(this, 'fillRect', args); },
    strokeRect: function (this: RecordingContext, ...args: number[]): void { record(this, 'strokeRect', args); },
    rect: function (this: RecordingContext, ...args: number[]): void { record(this, 'rect', args); },
    clip: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'clip', args); },
    beginPath: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'beginPath', args); },
    closePath: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'closePath', args); },
    moveTo: function (this: RecordingContext, ...args: number[]): void { record(this, 'moveTo', args); },
    lineTo: function (this: RecordingContext, ...args: number[]): void { record(this, 'lineTo', args); },
    fill: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'fill', args); },
    stroke: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'stroke', args); },
    drawImage: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'drawImage', args); },
    save: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'save', args); alphaStack.push(this.globalAlpha); },
    restore: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'restore', args); this.globalAlpha = alphaStack.pop() ?? this.globalAlpha; },
    setTransform: function (this: RecordingContext, ...args: number[]): void { record(this, 'setTransform', args); },
    setLineDash: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'setLineDash', args); },
    translate: function (this: RecordingContext, ...args: number[]): void { record(this, 'translate', args); },
    scale: function (this: RecordingContext, ...args: number[]): void { record(this, 'scale', args); },
    arc: function (this: RecordingContext, ...args: number[]): void { record(this, 'arc', args); },
    fillText: function (this: RecordingContext, ...args: unknown[]): void { record(this, 'fillText', args); }
  };
  return context;
}

export function record(context: RecordingContext, name: string, args: unknown[]): void {
  context.calls.push(name);
  context.records.push({
    name,
    args,
    fillStyle: context.fillStyle,
    strokeStyle: context.strokeStyle,
    globalAlpha: context.globalAlpha,
    lineWidth: context.lineWidth,
    font: context.font,
    textAlign: context.textAlign ?? ''
  });
}

