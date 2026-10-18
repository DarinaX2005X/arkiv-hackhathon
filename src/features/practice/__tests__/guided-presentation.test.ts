import { describe, expect, it } from 'vitest';
import { createMemoryStorage, LocalRepository } from '../../../data/local';
import { SMALL_WORKS_NOW, smallWorksRecords } from '../../../domain/fixtures';
import { practiceAssignmentRows } from '../GuidedPractice';
import { runGuidedPracticeAction } from '../guided';

describe('saved practice assignment decisions', () => {
  it('keeps Oak’s saved assignment visible with its withdrawal, then shows the repaired owners', async () => {
    const repository = new LocalRepository({ storage: createMemoryStorage(), namespace: 'practice', now: () => SMALL_WORKS_NOW, logicalClock: true });
    expect(repository.seed(smallWorksRecords()).ok).toBe(true);
    const now = () => repository.currentTime();
    await runGuidedPracticeAction(repository, 'add_oak', now);
    await runGuidedPracticeAction(repository, 'approve', now);
    const withdrawn = await runGuidedPracticeAction(repository, 'withdraw_oak', now);
    expect(practiceAssignmentRows(withdrawn.project).find(row => row.id === 'transport')?.owners.map(owner => ({ name: owner.name, status: owner.status })))
      .toEqual([{ name: 'Oak', status: 'withdrawn' }]);
    const repaired = await runGuidedPracticeAction(repository, 'repair', now);
    expect(practiceAssignmentRows(repaired.project).find(row => row.id === 'transport')?.owners.map(owner => ({ name: owner.name, status: owner.status })))
      .toEqual([{ name: 'Cedar', status: null }]);
  });
});
