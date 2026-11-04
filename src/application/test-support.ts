import type { LayeredDocument } from '../domain';
import {
  cloneLayeredDocument,
  cloneSessionHistory,
  compareFolders,
  compareProjectsByModified,
  decodeDocumentWithInfo,
  encodeDocument,
  folderItemKey,
  keepHiddenKeys,
  levelOfFolder,
  levelOfProject,
  MAX_GALLERY_ORDER_KEYS,
  ordersAfterFolderDelete,
  ordersAfterLeaving,
  ordersTakingSpot,
  ordersWithoutKeys,
  parseItemKey,
  PersistenceError,
  priorAssignments,
  projectItemKey,
  projectsLeaving,
  restoreMemberships,
  ROOT_LEVEL_ID,
  sha256,
  storedKeys,
  TRASH_RETENTION_MS,
  type CreatedFolder,
  type CreateFolderInput,
  type GalleryLevelData,
  type GalleryOrder,
  type GalleryUndo,
  type ProjectFolderAssignment,
  type PreparedDocumentCapability,
  type ProjectAsset,
  type ProjectAssetInput,
  type ProjectCopy,
  type ProjectFolder,
  type ProjectGalleryIndex,
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

function invalidMetadata(message: string): never {
  throw new PersistenceError('invalid-metadata', message);
}

/**
 * An in-memory workspace repository that records every save and can be made
 * to fail or pause. Its gallery methods read its maps, call the same planners
 * in gallery-order.ts that ProjectRepository calls, and write the results.
 */
export class MemoryRepository implements WorkspaceRepository {
  readonly records = new Map<string, ProjectRecord>();
  readonly saveCalls: Array<{ id: string; revision: number }> = [];
  readonly saveModes: Array<SaveOptions['mode']> = [];
  readonly saveDocuments: LayeredDocument[] = [];
  readonly preparedSaveCalls: string[] = [];
  readonly folders = new Map<string, ProjectFolder>();
  readonly folderAssignments = new Map<string, ProjectFolderAssignment>();
  private galleryOrders: GalleryOrder[] = [];
  private readonly projectOpens = new Map<string, number>();
  private readonly trashed = new Map<string, number>();
  failSaves = false;
  beforeSave: (() => Promise<void> | void) | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async save(projectId: string, metadata: ProjectMetadata, document: LayeredDocument, assets?: readonly ProjectAssetInput[], options: SaveOptions = {}): Promise<SaveResult> {
    if (this.failSaves) throw new PersistenceError('storage-failure', 'Test storage failure.');
    await this.beforeSave?.();
    this.saveModes.push(options.mode);
    this.saveDocuments.push(document);
    const current = this.records.get(projectId);
    if (options.mode === 'retain') {
      const expectedRevision = options.expectedRevision ?? options.expectedHead?.revision;
      const expectedChecksum = options.expectedHead?.checksum;
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
    const record = this.trashed.has(projectId) ? undefined : this.records.get(projectId);
    return record === undefined ? undefined : copyRecord(record);
  }

  async listProjects(): Promise<ProjectMetadata[]> {
    return [...this.records.values()]
      .filter((record) => !this.trashed.has(record.metadata.id))
      .map((record) => ({ ...record.metadata }))
      .sort(compareProjectsByModified);
  }

  private levelData(): GalleryLevelData {
    return {
      folders: [...this.folders.values()],
      assignments: [...this.folderAssignments.values()],
      projects: [...this.records.values()].filter((record) => !this.trashed.has(record.metadata.id)).map((record) => ({ id: record.metadata.id, createdAt: record.metadata.createdAt }))
    };
  }

  private deletePermanently(projectIds: readonly string[]): void {
    for (const projectId of projectIds) {
      this.records.delete(projectId);
      this.folderAssignments.delete(projectId);
      this.projectOpens.delete(projectId);
      this.trashed.delete(projectId);
    }
    this.galleryOrders = ordersWithoutKeys(this.galleryOrders, new Set(projectIds.map(projectItemKey)));
  }

  async listGalleryIndex(): Promise<ProjectGalleryIndex> {
    const live = new Set(this.levelData().projects.map((project) => project.id));
    return {
      folders: [...this.folders.values()].sort(compareFolders).map((folder) => ({ ...folder })),
      assignments: [...this.folderAssignments.values()]
        .filter((assignment) => this.folders.has(assignment.folderId) && live.has(assignment.projectId))
        .map((assignment) => ({ ...assignment })),
      orders: this.galleryOrders.map((order) => ({ levelId: order.levelId, keys: [...order.keys] })),
      opens: [...this.projectOpens].filter(([projectId]) => live.has(projectId)).map(([projectId, openedAt]) => ({ projectId, openedAt }))
    };
  }

  async createFolder(input: CreateFolderInput): Promise<CreatedFolder> {
    const { id, takesSpotOf } = input;
    const parentId = input.parentId ?? null;
    const projectIds = input.projectIds ?? [];
    if (parentId !== null && this.folders.get(parentId)?.parentId !== null) invalidMetadata('Folder parent must be an existing top-level folder.');
    const data = this.levelData();
    const existing = new Set(data.projects.map((project) => project.id));
    if (projectIds.some((projectId) => !existing.has(projectId))) invalidMetadata('Project does not exist.');
    const parentLevel = parentId ?? ROOT_LEVEL_ID;
    if (takesSpotOf !== undefined && (!existing.has(takesSpotOf) || levelOfProject(data, takesSpotOf) !== parentLevel)) invalidMetadata('A new folder can only take the spot of a project in its level.');
    const undo: GalleryUndo = { assignments: priorAssignments(data, projectIds), folderParents: [], createdFolderId: id };
    const left = ordersAfterLeaving(data, this.galleryOrders, projectsLeaving(data, projectIds), id);
    this.galleryOrders = takesSpotOf === undefined ? left : ordersTakingSpot(data, left, parentLevel, takesSpotOf, id);
    const now = this.now();
    const folder: ProjectFolder = { id, name: input.name.trim(), parentId, createdAt: now, updatedAt: now };
    this.folders.set(id, folder);
    for (const projectId of projectIds) this.folderAssignments.set(projectId, { projectId, folderId: id, assignedAt: now });
    return { folder: { ...folder }, undo };
  }

  async renameFolder(folderId: string, name: string): Promise<ProjectFolder> {
    const existing = this.folders.get(folderId);
    if (!existing) invalidMetadata('Folder does not exist.');
    const folder = { ...existing, name: name.trim(), updatedAt: this.now() };
    this.folders.set(folderId, folder);
    return { ...folder };
  }

  async deleteFolder(folderId: string): Promise<void> {
    const deleted = this.folders.get(folderId);
    if (!deleted) return;
    this.galleryOrders = ordersAfterFolderDelete(this.levelData(), this.galleryOrders, deleted);
    for (const child of this.folders.values()) {
      if (child.parentId === folderId) this.folders.set(child.id, { ...child, parentId: deleted.parentId, updatedAt: this.now() });
    }
    for (const [projectId, assignment] of this.folderAssignments) {
      if (assignment.folderId !== folderId) continue;
      if (deleted.parentId === null) this.folderAssignments.delete(projectId);
      else this.folderAssignments.set(projectId, { ...assignment, folderId: deleted.parentId });
    }
    this.folders.delete(folderId);
  }

  async moveProjectsToFolder(projectIds: readonly string[], folderId: string | null): Promise<GalleryUndo> {
    if (projectIds.length === 0 || new Set(projectIds).size !== projectIds.length) invalidMetadata('Projects to move must be a non-empty list without repeats.');
    const data = this.levelData();
    const existing = new Set(data.projects.map((project) => project.id));
    if (projectIds.some((projectId) => !existing.has(projectId))) invalidMetadata('Project does not exist.');
    if (folderId !== null && !this.folders.has(folderId)) invalidMetadata('Folder does not exist.');
    const undo: GalleryUndo = { assignments: priorAssignments(data, projectIds), folderParents: [], createdFolderId: null };
    this.galleryOrders = ordersAfterLeaving(data, this.galleryOrders, projectsLeaving(data, projectIds), folderId ?? ROOT_LEVEL_ID);
    const now = this.now();
    for (const projectId of projectIds) {
      if (folderId === null) this.folderAssignments.delete(projectId);
      else this.folderAssignments.set(projectId, { projectId, folderId, assignedAt: now });
    }
    return undo;
  }

  async moveFolder(folderId: string, parentId: string | null): Promise<GalleryUndo> {
    const folder = this.folders.get(folderId);
    if (!folder) invalidMetadata('Folder does not exist.');
    if (parentId !== null) {
      if (parentId === folderId) invalidMetadata('A folder cannot be moved into itself.');
      if (this.folders.get(parentId)?.parentId !== null) invalidMetadata('Folder parent must be an existing top-level folder.');
      if ([...this.folders.values()].some((child) => child.parentId === folderId)) invalidMetadata('A folder with subfolders cannot be moved into another folder.');
    }
    const data = this.levelData();
    const undo: GalleryUndo = { assignments: [], folderParents: [{ folderId, parentId: folder.parentId }], createdFolderId: null };
    this.galleryOrders = ordersAfterLeaving(data, this.galleryOrders, [{ key: folderItemKey(folderId), from: levelOfFolder(data, folder) }], parentId ?? ROOT_LEVEL_ID);
    this.folders.set(folderId, { ...folder, parentId, updatedAt: this.now() });
    return undo;
  }

  async setGalleryOrder(levelId: string, keys: readonly string[]): Promise<void> {
    if (keys.length > MAX_GALLERY_ORDER_KEYS) invalidMetadata('Gallery order is malformed.');
    if (new Set(keys).size !== keys.length || keys.some((key) => parseItemKey(key) === null)) invalidMetadata('Gallery order keys must be unique item keys.');
    if (levelId !== ROOT_LEVEL_ID && !this.folders.has(levelId)) invalidMetadata('Gallery level does not exist.');
    const next = keepHiddenKeys(storedKeys(this.galleryOrders, levelId) ?? [], keys);
    this.galleryOrders = [...this.galleryOrders.filter((order) => order.levelId !== levelId), { levelId, keys: next }];
  }

  async restoreGallery(undo: GalleryUndo): Promise<void> {
    const next = restoreMemberships(undo, { folders: [...this.folders.values()], assignments: [...this.folderAssignments.values()] }, new Set(this.records.keys()), this.now());
    this.folders.clear();
    for (const folder of next.folders) this.folders.set(folder.id, folder);
    this.folderAssignments.clear();
    for (const assignment of next.assignments) this.folderAssignments.set(assignment.projectId, assignment);
    if (undo.createdFolderId !== null) this.galleryOrders = this.galleryOrders.filter((order) => order.levelId !== undo.createdFolderId);
  }

  async recordProjectOpen(projectId: string): Promise<void> {
    if (this.records.has(projectId)) this.projectOpens.set(projectId, this.now());
  }

  async trashProjects(projectIds: readonly string[]): Promise<void> {
    this.deletePermanently([...this.trashed.keys()]);
    const data = this.levelData();
    const trashed = projectIds.filter((projectId) => this.records.has(projectId));
    this.galleryOrders = ordersAfterLeaving(data, this.galleryOrders, projectsLeaving(data, trashed), null);
    const now = this.now();
    for (const projectId of trashed) this.trashed.set(projectId, now);
  }

  async restoreTrashedProjects(projectIds: readonly string[]): Promise<void> {
    for (const projectId of projectIds) this.trashed.delete(projectId);
  }

  async purgeTrashedProjects(): Promise<void> {
    const cutoff = this.now() - TRASH_RETENTION_MS;
    this.deletePermanently([...this.trashed].filter(([, deletedAt]) => deletedAt < cutoff).map(([projectId]) => projectId));
  }

  /** All or nothing, like ProjectRepository: a missing source fails the batch, and a trashed one is skipped. */
  async duplicateProjects(copies: readonly ProjectCopy[], folderId: string | null): Promise<ProjectMetadata[]> {
    if (new Set(copies.map((copy) => copy.id)).size !== copies.length) invalidMetadata('Copy IDs must be unique.');
    if (folderId !== null && !this.folders.has(folderId)) invalidMetadata('Folder does not exist.');
    const kept = copies.filter((copy) => !this.trashed.has(copy.sourceId));
    for (const copy of kept) {
      if (!this.records.has(copy.sourceId)) invalidMetadata(`Project ${copy.sourceId} does not exist.`);
      if (this.records.has(copy.id)) invalidMetadata('A project with the copy ID already exists.');
    }
    const now = this.now();
    return kept.map((copy) => {
      const source = copyRecord(this.records.get(copy.sourceId)!);
      const metadata: ProjectMetadata = { ...source.metadata, id: copy.id, title: copy.title, createdAt: copy.createdAt, updatedAt: copy.updatedAt };
      this.records.set(copy.id, { metadata, document: source.document, head: { ...source.head!, projectId: copy.id }, recovery: null, assets: source.assets });
      if (folderId !== null) this.folderAssignments.set(copy.id, { projectId: copy.id, folderId, assignedAt: now });
      return { ...metadata };
    });
  }
}
