import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createDocument } from '../domain';
import {
  exportArchive,
  importArchive,
  parseArchive,
  ProjectRepository,
  recordDailyProgress,
  NeedlewiseDatabase,
  type ProjectMetadata
} from './index';

let databaseCounter = 20_000;

function nextRepository(): ProjectRepository {
  databaseCounter += 1;
  return new ProjectRepository(new NeedlewiseDatabase(`needlewise-activity-test-${String(databaseCounter)}`), { now: () => 10 });
}

function metadata(id: string, revision: number): ProjectMetadata {
  return { id, title: 'Activity', notes: '', createdAt: 1, updatedAt: 1, revision };
}

describe('durable progress activity', () => {
  it('round-trips bounded daily aggregates through repository saves and archives', async () => {
    const repo = nextRepository();
    const importedRepo = nextRepository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      let activity = recordDailyProgress(undefined, '2026-08-30', 4, 1);
      activity = recordDailyProgress(activity, '2026-08-30', 2, 3);
      await repo.save('activity', metadata('activity', document.revision), document, undefined, { activity });
      // Repeating the same save is an upsert of the same date rows, not an
      // append to a second event log.
      await repo.save('activity', metadata('activity', document.revision), document, undefined, { activity, allowSameRevision: true });

      const loaded = await repo.load('activity');
      expect(loaded?.activity).toEqual({ daily: [{ date: '2026-08-30', marked: 6, unmarked: 4 }] });
      const archive = await repo.exportProject('activity');
      const parsed = await parseArchive(archive);
      expect(parsed.activity).toEqual(loaded?.activity);
      const imported = await importedRepo.importProject(archive);
      expect(imported.activity).toEqual(loaded?.activity);

      const directArchive = await exportArchive({ metadata: metadata('direct', 0), document, assets: [] });
      expect((await importArchive(directArchive)).activity).toBeUndefined();
    } finally {
      await repo.close();
      await importedRepo.close();
      await repo.db.delete();
      await importedRepo.db.delete();
    }
  });

  it('keeps a valid document loadable when auxiliary activity is corrupt', async () => {
    const repo = nextRepository();
    try {
      const document = createDocument({ width: 1, height: 1, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
      await repo.save('corrupt-activity', metadata('corrupt-activity', document.revision), document, undefined, {
        activity: { daily: [{ date: '2026-08-30', marked: 1, unmarked: 0 }] }
      });
      const row = await repo.db.dailyActivity.get(['corrupt-activity', '2026-08-30']);
      if (!row) throw new Error('missing activity row');
      row.marked = -1;
      await repo.db.dailyActivity.put(row);

      const loaded = await repo.load('corrupt-activity');
      expect(loaded?.document).toBeDefined();
      expect(loaded?.activity).toEqual({ daily: [] });
      expect(loaded?.health?.warnings.some((warning) => warning.includes('activity'))).toBe(true);
      const health = await repo.inspectProjectHealth('corrupt-activity');
      expect(health?.warnings.some((warning) => warning.includes('activity'))).toBe(true);
    } finally {
      await repo.close();
      await repo.db.delete();
    }
  });
});
