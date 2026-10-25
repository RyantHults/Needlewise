import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';
import { createDocument } from './domain';
import { DEFAULT_CATALOG_DEFINITION } from './catalog';
import { ProjectWorkspace } from './application/workspace';
import { NeedlewiseDatabase, ProjectRepository } from './persistence';
import { applyCommand } from './domain/test-fixtures';

/**
 * Locks the reported flow with the real stack: thread rows AND the
 * estimate-card total render skeins through a settings units round-trip
 * (finished size still follows along in cm/in).
 */
describe('measurement units end-to-end', () => {
  it('thread skeins survive the settings toggle both ways with exact strings', async () => {
    // Seed a stored project with stitches and calibrated settings. The app
    // opens its own workspace on the default database, so seed there.
    const seedDb = new NeedlewiseDatabase('needlewise-local');
    const seedRepo = new ProjectRepository(seedDb, { now: () => 10 });
    const seedWorkspace = new ProjectWorkspace({ repository: seedRepo, clock: { now: () => 100 }, projectIdFactory: () => 'units-flow' });
    let pattern = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 14, height: 14, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] });
    pattern = applyCommand(pattern, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
    await seedWorkspace.createProject({ title: 'Units quilt', document: pattern, materialSettings: { strands: 2, waste: 0.2, skeinLengthMeters: 8 } });
    await seedWorkspace.dispose();
    await seedRepo.close();

    window.history.replaceState({}, '', '/patterns');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Open Units quilt/ }));
    // Thread totals live in the export dialog, opened from the editor header.
    fireEvent.click(await screen.findByRole('button', { name: 'Export pattern' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export pattern' });
    const totals = () => within(within(dialog).getByRole('region', { name: 'Thread totals' }));
    const setUnits = async (name: 'Metric' | 'Imperial') => {
      fireEvent.click(within(dialog).getByRole('button', { name }));
      await waitFor(() => expect(within(dialog).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true'));
    };

    await totals().findByText(/Finished size: 2\.54 cm × 2\.54 cm/);
    expect(totals().getByText('0.01 skeins')).toBeInTheDocument();
    expect(totals().getByText('0.04–0.05 m')).toBeInTheDocument();
    expect(totals().getByText('0.01 skeins · 0.04–0.05 m')).toBeInTheDocument();

    await setUnits('Imperial');
    await totals().findByText(/Finished size: 1 in × 1 in/);
    expect(totals().getByText('0.01 skeins')).toBeInTheDocument();
    expect(totals().getByText('0.04–0.05 yd')).toBeInTheDocument();
    expect(totals().getByText('0.01 skeins · 0.04–0.05 yd')).toBeInTheDocument();

    await setUnits('Metric');
    await totals().findByText(/Finished size: 2\.54 cm × 2\.54 cm/);
    expect(totals().getByText('0.01 skeins')).toBeInTheDocument();
    expect(totals().getByText('0.04–0.05 m')).toBeInTheDocument();
    expect(totals().getByText('0.01 skeins · 0.04–0.05 m')).toBeInTheDocument();
  }, 30000);
});
