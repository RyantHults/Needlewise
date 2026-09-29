import '@testing-library/jest-dom/vitest';

// jsdom implements neither Path2D nor a 2D canvas context. Symbol outlines are
// drawn through Path2D, so give tests a stand-in that carries the path data
// the production code supplies. Only the constructor is modelled: assertions
// belong on the recorded context calls, not on this shim.
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class {
    readonly d: string;
    constructor(d?: string) {
      this.d = d ?? '';
    }
  } as unknown as typeof Path2D;
}
