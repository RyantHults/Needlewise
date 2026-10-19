/** A count with its noun, such as "1 cell" or "3 cells". */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}
