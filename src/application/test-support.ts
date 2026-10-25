import type { LayeredDocument } from '../domain';
import {
  cloneLayeredDocument,
  cloneSessionHistory,
  decodeDocumentWithInfo,
  encodeDocument,
  PersistenceError,
  sha256,
  type CreateFolderInput,
  type PreparedDocumentCapability,
  type ProjectAsset,
  type ProjectAssetInput,
  type ProjectFolder,
  type ProjectFolderIndex,
  type ProjectMetadata,
  type ProjectRecord,
  type SaveOptions,
  type SaveResult,
  type SessionHistoryEnvelope
} from '../persistence';
import { consumePreparedDocumentCapability } from '../persistence/preparation-client';
import type { WorkspaceRepository } from './types';

/** A reload goes through the real encoder and decoder, so a loaded document is never the saved object. */
function copyRecord(record: ProjectRecord): ProjectRecord {
  return {
    metadata: { ...record.metadata },
    document: decodeDocumentWithInfo(encodeDocument(record.document)).document,
    ...(record.head === undefined ? {} : { head: { ...record.head } }),
    recovery: record.recovery === null ? null : { revision: record.recovery.revision, document: cloneLayeredDocument(record.recovery.document) },
    assets: record.assets.map((asset) => ({ ...asset, data: new Uint8Array(asset.data) })),
    ...(record.history === undefined ? {} : { history: cloneSessionHistory(record.history) })
  };
}

/** An in-memory workspace repository that records every save and can be made to fail or pause. */
export class MemoryRepository implements WorkspaceRepository {
  readonly records = new Map<string, ProjectRecord>();
  readonly saveCalls: Array<{ id: string; revision: number }> = [];
  readonly saveModes: Array<SaveOptions['mode']> = [];
  readonly saveDocuments: LayeredDocument[] = [];
  readonly preparedSaveCalls: string[] = [];
  readonly folders = new Map<string, ProjectFolder>();
  readonly folderAssignments = new Map<string, string>();
  failSaves = false;
  beforeSave: (() => Promise<void> | void) | undefined;

  async save(projectId: string, metadata: ProjectMetadata, document: LayeredDocument, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    if (this.failSaves) throw new PersistenceError('storage-failure', 'Test storage failure.');
    await this.beforeSave?.();
    this.saveModes.push(options.mode);
    this.saveDocuments.push(document);
    const current = this.records.get(projectId);
    if (options.mode === 'retain') {
      const expectedHead = options.expectedHead;
      const expectedRevision = options.expectedRevision ?? (typeof expectedHead === 'number' ? expectedHead : expectedHead?.revision);
      const expectedChecksum = typeof expectedHead === 'object' && expectedHead !== null ? expectedHead.checksum : undefined;
      if (!current?.head || expectedRevision !== current.head.revision || (expectedChecksum !== undefined && expectedChecksum !== current.head.checksum)) return { committed: false, stale: true, revision: current?.document.revision ?? document.revision };
    } else if (current && (current.document.revision > document.revision || (current.document.revision === document.revision && !options.allowSameRevision))) return { committed: false, stale: true, revision: current.document.revision };
    const retained = options.mode === 'retain';
    const persistedDocument = retained && current ? current.document : document;
    const head = retained && current?.head
      ? { ...current.head }
      : { projectId, revision: persistedDocument.revision, checksum: await sha256(encodeDocument(persistedDocument)) };
    const nextAssets: ProjectAsset[] = assets === undefined
      ? current?.assets ?? []
      : [];
    if (assets !== undefined) {
      for (const asset of assets) {
        const data = asset.data instanceof Uint8Array ? asset.data.slice() : asset.data instanceof ArrayBuffer ? new Uint8Array(asset.data).slice() : new Uint8Array(await asset.data.arrayBuffer());
        nextAssets.push({ id: asset.id, name: asset.name, mimeType: asset.mimeType, data, checksum: await sha256(data) });
      }
    }
    this.saveCalls.push({ id: projectId, revision: persistedDocument.revision });
    this.records.set(projectId, {
      metadata: { ...metadata },
      document: cloneLayeredDocument(persistedDocument),
      head,
      recovery: retained ? current?.recovery ?? null : current === undefined ? null : { revision: current.document.revision, document: cloneLayeredDocument(current.document) },
      assets: nextAssets,
      ...(options.history !== undefined && 'trace' in options.history ? { history: cloneSessionHistory(options.history as SessionHistoryEnvelope) } : {})
    });
    return { committed: true, stale: false, revision: persistedDocument.revision, head };
  }

  async savePrepared(projectId: string, metadata: ProjectMetadata, prepared: PreparedDocumentCapability, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    this.preparedSaveCalls.push(options.preparedRequestId ?? '');
    return consumePreparedDocumentCapability(
      prepared,
      { projectId, revision: metadata.revision, requestId: options.preparedRequestId ?? '' },
      (bytes) => this.save(projectId, metadata, decodeDocumentWithInfo(bytes).document, assets, options)
    );
  }

  async load(projectId: string): Promise<ProjectRecord | undefined> {
    const record = this.records.get(projectId);
    return record === undefined ? undefined : copyRecord(record);
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    return [...this.records.values()].sort((left, right) => right.metadata.updatedAt - left.metadata.updatedAt).map((record) => ({ ...record.metadata }));
  }

  async deleteProject(projectId: string): Promise<void> {
    this.records.delete(projectId);
  }

  async listFolderIndex(): Promise<ProjectFolderIndex> {
    return {
      folders: [...this.folders.values()].map((folder) => ({ ...folder })),
      assignments: [...this.folderAssignments].map(([projectId, folderId]) => ({ projectId, folderId }))
    };
  }

  async createFolder(input: CreateFolderInput): Promise<ProjectFolder> {
    const now = Date.now();
    const folder: ProjectFolder = { id: input.id, name: input.name, parentId: input.parentId ?? null, createdAt: now, updatedAt: now };
    this.folders.set(folder.id, folder);
    return { ...folder };
  }

  async renameFolder(folderId: string, name: string): Promise<ProjectFolder> {
    const folder = { ...this.folders.get(folderId)!, name, updatedAt: Date.now() };
    this.folders.set(folderId, folder);
    return { ...folder };
  }

  async deleteFolder(folderId: string): Promise<void> {
    this.folders.delete(folderId);
    for (const [projectId, assigned] of this.folderAssignments) if (assigned === folderId) this.folderAssignments.delete(projectId);
  }

  async moveProjectToFolder(projectId: string, folderId: string | null): Promise<void> {
    if (folderId === null) this.folderAssignments.delete(projectId);
    else this.folderAssignments.set(projectId, folderId);
  }

  async moveFolder(folderId: string, parentId: string | null): Promise<void> {
    this.folders.set(folderId, { ...this.folders.get(folderId)!, parentId, updatedAt: Date.now() });
  }
}
