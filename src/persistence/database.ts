import Dexie, { type Table } from 'dexie';
import type { ProjectMetadata, StoredDocumentSnapshot, StoredProjectAsset, StoredDailyProgressAggregate, StoredProjectHead } from './types';

export class NeedlewiseDatabase extends Dexie {
  projects!: Table<ProjectMetadata, string>;
  currentSnapshots!: Table<StoredDocumentSnapshot, string>;
  recoverySnapshots!: Table<StoredDocumentSnapshot, string>;
  projectHeads!: Table<StoredProjectHead, string>;
  assets!: Table<StoredProjectAsset, [string, string]>;
  dailyActivity!: Table<StoredDailyProgressAggregate, [string, string]>;

  constructor(name = 'needlewise-local') {
    super(name);
    this.version(1).stores({
      projects: 'id',
      currentSnapshots: 'projectId',
      recoverySnapshots: 'projectId',
      assets: '[projectId+id], projectId'
    });
    this.version(2).stores({
      projects: 'id',
      currentSnapshots: 'projectId',
      recoverySnapshots: 'projectId',
      assets: '[projectId+id], projectId',
      dailyActivity: '[projectId+date], projectId'
    });
    this.version(3).stores({
      projects: 'id',
      currentSnapshots: 'projectId',
      recoverySnapshots: 'projectId',
      assets: '[projectId+id], projectId',
      dailyActivity: '[projectId+date], projectId'
    });
    // Project metadata is JSON-like data in the projects object store, so the
    // new optional Aida count needs no index. This version is nevertheless
    // explicit: opening an older database runs the copy-on-write migration
    // boundary while records that predate Aida remain without the field.
    this.version(4).stores({
      projects: 'id, aidaCount',
      currentSnapshots: 'projectId',
      recoverySnapshots: 'projectId',
      assets: '[projectId+id], projectId',
      dailyActivity: '[projectId+date], projectId'
    });
    this.version(5).stores({
      projects: 'id, aidaCount',
      currentSnapshots: 'projectId',
      recoverySnapshots: 'projectId',
      projectHeads: 'projectId',
      assets: '[projectId+id], projectId',
      dailyActivity: '[projectId+date], projectId'
    });
  }
}

export function createDatabase(name = 'needlewise-local'): NeedlewiseDatabase {
  return new NeedlewiseDatabase(name);
}

export const ProjectDatabase = NeedlewiseDatabase;
export const openDatabase = createDatabase;
