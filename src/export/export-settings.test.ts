import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_SETTINGS_STORAGE_KEY,
  loadExportSettings,
  normalizeExportSettings,
  saveExportSettings,
  type ExportSettingsStorage
} from './export-settings';

function memoryStorage(initial?: string): ExportSettingsStorage & { value?: string } {
  const storage: ExportSettingsStorage & { value?: string } = {
    value: initial,
    getItem: () => storage.value ?? null,
    setItem: (_key, value) => { storage.value = value; }
  };
  return storage;
}

const throwing: ExportSettingsStorage = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); }
};

describe('export settings', () => {
  it('defaults', () => {
    expect(DEFAULT_EXPORT_SETTINGS).toEqual({ paper: 'letter', orientation: 'portrait', margins: 'standard', pageNumbers: true, overlap: 0, cellSizeMm: 4, chartStyle: 'symbol' });
  });

  it('normalizes unknown input to defaults and clamps overlap', () => {
    expect(normalizeExportSettings(null)).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(normalizeExportSettings('x')).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(normalizeExportSettings({ paper: 'legal', orientation: 'sideways', margins: 1, pageNumbers: 'yes', overlap: NaN, cellSizeMm: 7, chartStyle: 'grayscale' })).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(normalizeExportSettings({ overlap: 9 }).overlap).toBe(3);
    expect(normalizeExportSettings({ overlap: -2 }).overlap).toBe(0);
    expect(normalizeExportSettings({ overlap: 1.6 }).overlap).toBe(2);
    expect(normalizeExportSettings({ paper: 'a4', orientation: 'landscape', margins: 'narrow', pageNumbers: false, cellSizeMm: 3.2, chartStyle: 'combined' })).toMatchObject({ paper: 'a4', orientation: 'landscape', margins: 'narrow', pageNumbers: false, cellSizeMm: 3.2, chartStyle: 'combined' });
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const settings = { ...DEFAULT_EXPORT_SETTINGS, paper: 'a4' as const, overlap: 2 };
    expect(saveExportSettings(settings, storage)).toBe(true);
    expect(loadExportSettings(storage)).toEqual(settings);
  });

  it('tolerates absent, throwing and corrupt storage', () => {
    expect(loadExportSettings(throwing)).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(saveExportSettings(DEFAULT_EXPORT_SETTINGS, throwing)).toBe(false);
    expect(loadExportSettings(memoryStorage('{not json'))).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(loadExportSettings(memoryStorage())).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(saveExportSettings(DEFAULT_EXPORT_SETTINGS, undefined) ).toBeTypeOf('boolean');
    expect(EXPORT_SETTINGS_STORAGE_KEY).toBe('needlewise.export-settings.v1');
  });
});
