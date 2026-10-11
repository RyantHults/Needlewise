import labelFontUrl from '../../fonts/LibertinusMath-Regular.ttf?url';

/**
 * Bytes of the label font embedded in exported PDFs. Libertinus Math (OFL,
 * licence text in `fonts/OFL.txt`) covers Latin, digits and the punctuation
 * the legend uses. The file is a build asset, not part of the precached
 * application shell, and is fetched only when an export starts.
 */
export async function loadPdfLabelFont(fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetchImpl(labelFontUrl);
  if (!response.ok) throw new Error(`The PDF label font could not be loaded (${String(response.status)}).`);
  return new Uint8Array(await response.arrayBuffer());
}
