import { useEffect, useState } from 'react';
import type { ProjectWorkspace } from '../application/workspace';
import type { DisplayUnits } from '../domain';
import { useLatestRequest } from './latest-request';

/** The active project's display units, and a change that shows at once and rolls back if the save fails. */
export function useProjectUnits(workspace: Pick<ProjectWorkspace, 'metadata' | 'updateActiveMetadata'>): [DisplayUnits, (next: DisplayUnits) => Promise<void>] {
  const saved = workspace.metadata?.units ?? 'metric';
  const [units, setUnits] = useState<DisplayUnits>(saved);
  const request = useLatestRequest();

  useEffect(() => {
    setUnits(saved);
  }, [workspace.metadata?.id, saved]);

  // A save still pending for another project must not roll this one back.
  useEffect(() => request.cancel, [workspace.metadata?.id, request]);

  const changeUnits = async (next: DisplayUnits) => {
    if (next === units) return;
    const isCurrent = request.begin();
    setUnits(next);
    try {
      await workspace.updateActiveMetadata({ units: next });
    } catch {
      // Only the latest change rolls back, to the value from before it; an older failure would undo a newer choice.
      if (isCurrent()) setUnits(units);
    }
  };
  return [units, changeUnits];
}
