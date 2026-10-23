import { useState } from 'react';
import { readBlobBytes, SNIFF_BYTES } from '../../import/import-protocol';
import { findImporter, importerAccept } from '../../import/registry';
import { ErrorNotice } from '../controls/Notice';
import { FileDropZone } from '../FileDropZone';
import { useLatestRequest } from '../latest-request';
import { Modal } from '../Modal';

type Props = {
  returnFocus?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** A file some importer recognizes; the caller opens the review. */
  onFile: (file: File) => void;
};

const UNSUPPORTED = 'This file is not a pattern Needlewise can import. Choose a PDF pattern.';

/** The first step of an import: pick a file, checked against the registered importers before the review opens. */
export function ImportUploadModal({ returnFocus, onClose, onFile }: Props) {
  const [error, setError] = useState('');
  // Only the latest choice may proceed, and none after unmount.
  const request = useLatestRequest();

  async function choose(file: File) {
    const isCurrent = request.begin();
    setError('');
    let supported: boolean;
    try {
      supported = findImporter(await readBlobBytes(file.slice(0, SNIFF_BYTES))) !== undefined;
    } catch {
      if (isCurrent()) setError('The file could not be read.');
      return;
    }
    if (!isCurrent()) return;
    if (supported) onFile(file);
    else setError(UNSUPPORTED);
  }

  return (
    <Modal className="import-upload-modal" eyebrow="New project" title="Import a pattern" closeLabel="Close import dialog" describedBy="import-upload-intro" returnFocus={returnFocus} onClose={onClose}>
      <p className="control-note" id="import-upload-intro">Upload a pattern to import it into Needlewise. We currently support importing from PDFs.</p>
      <FileDropZone id="import-upload-file" accept={importerAccept()} inputLabel="Choose a pattern file to import" title="Drop a pattern here" hint="PDF charts with a symbol key, such as DMC patterns" onFile={file => void choose(file)} />
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </Modal>
  );
}
