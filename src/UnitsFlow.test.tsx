import 'fake-indexeddb/auto';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';
import { applyCommand, createDocument } from './domain';
import { ProjectWorkspace } from './application/workspace';
import { NeedlewiseDatabase, ProjectRepository } from './persistence';

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
    let pattern = createDocument({ width: 14, height: 14, palette: [{ id: 1, name: 'Ruby', color: '#AA0000' }] });
    pattern = applyCommand(pattern, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
    await seedWorkspace.createProject({ title: 'Units quilt', document: pattern, materialSettings: { strands: 2, waste: 0.2, skeinLengthMeters: 8 } });
    await seedWorkspace.dispose();
    await seedRepo.close();

    window.history.replaceState({}, '', '/patterns');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Open Units quilt/ }));
    const openMaterials = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Materials and progress' }));
      return screen.findByRole('dialog', { name: 'Plan the thread' });
    };
    const closeMaterials = async (dialog: HTMLElement) => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await screen.findByRole('button', { name: 'Materials and progress' });
    };
    let materials = await openMaterials();
    await within(materials).findByText(/^Total:/);
    expect(within(materials).getByText('Total: 0.01 skeins')).toBeInTheDocument();
    expect(within(materials).getByText('0.01 skeins')).toBeInTheDocument();
    expect(within(materials).getAllByText('0.04–0.05 yd').length).toBe(2);
    await closeMaterials(materials);

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Imperial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    materials = await openMaterials();
    await within(materials).findByText(/1 × 1 in/);
    expect(within(materials).getByText('Total: 0.01 skeins')).toBeInTheDocument();
    expect(within(materials).getByText('0.01 skeins')).toBeInTheDocument();
    expect(within(materials).getByText(/Total:/).textContent).toContain('0.04–0.05 yd');
    expect(within(materials).getAllByText('0.04–0.05 yd').length).toBe(2);
    await closeMaterials(materials);

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Metric' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    materials = await openMaterials();
    await within(materials).findByText(/2\.54 × 2\.54 cm/);
    expect(within(materials).getByText('Total: 0.01 skeins')).toBeInTheDocument();
    expect(within(materials).getByText('0.01 skeins')).toBeInTheDocument();
    expect(within(materials).getByText(/Total:/).textContent).toContain('0.04–0.05 yd');
    expect(within(materials).getAllByText('0.04–0.05 yd').length).toBe(2);
    await closeMaterials(materials);
  }, 30000);
});
