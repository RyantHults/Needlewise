/** Minimal DataTransfer stand-in: jsdom has no DataTransfer constructor. */
export function dropData(...files: File[]) {
  return { files: Object.assign([...files], { item: (index: number) => files[index] ?? null }), types: files.length ? ['Files'] : [], dropEffect: 'none' };
}
