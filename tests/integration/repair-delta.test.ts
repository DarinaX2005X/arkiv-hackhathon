import { describe, expect, it } from 'vitest';
import { createMemoryStorage, LocalRepository } from '../../src/data/local';
import { hashPlan } from '../../src/domain/canonical';
import { planDiff } from '../../src/domain/execution';
import { SMALL_WORKS_NOW, smallWorksRecords } from '../../src/domain/fixtures';
import { activeSource, deriveReadiness } from '../../src/domain/readiness';
import { runGuidedPracticeAction } from '../../src/features/practice/guided';
import { comparePlans } from '../../src/features/projects/selectors';

describe('persisted repair change explanation', () => {
  it('explains precisely Oak leaving, Juniper joining and Cedar changing roles without changing the other allocations', async () => {
    const storage = createMemoryStorage();
    const fresh = () => new LocalRepository({ storage, namespace: 'practice', logicalClock: true, now: () => SMALL_WORKS_NOW });
    const repository = fresh();
    const seeded = repository.seed(smallWorksRecords());
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const action = async (name: Parameters<typeof runGuidedPracticeAction>[1]) => {
      const client = fresh();
      return runGuidedPracticeAction(client, name, () => client.currentTime());
    };
    await action('add_oak');
    const agreed = await action('approve');
    await action('withdraw_oak');
    const repaired = await action('repair');
    const before = agreed.project.proposal!.payload.plan;
    const after = repaired.project.proposal!.payload.plan;
    const difference = planDiff(before, after);
    const owners = ['local:ash', 'local:cedar', 'local:elm', 'local:juniper', 'local:library', 'local:makerspace', 'local:willow'];
    expect(difference).toMatchObject({ addedPublishers: ['local:juniper'], removedPublishers: ['local:oak'],
      variantChanged: false, materialChanged: true, requiresFreshAgreement: owners });
    const changed = [...before.allocations, ...after.allocations]
      .filter(item => difference.changedAllocationIds.includes(item.id))
      .map(item => `${item.requirementId}:${item.publisherRoot}`);
    expect(changed.sort()).toEqual(['installation:local:cedar', 'installation:local:juniper', 'transport:local:cedar', 'transport:local:oak']);
    const installation = comparePlans(before, after, repaired.project).find(item => item.id === 'installation')!;
    const transport = comparePlans(before, after, repaired.project).find(item => item.id === 'transport')!;
    expect(installation.before).toContain('Cedar /');
    expect(installation.after).toContain('Juniper /');
    expect(installation.before).toContain('Willow /');
    expect(installation.after).toContain('Willow /');
    expect(transport.before).toContain('Oak /');
    expect(transport.after).toContain('Cedar /');
    for (const id of ['venue', 'boards', 'kit', 'hosting']) {
      expect(after.allocations.filter(item => item.requirementId === id)).toEqual(before.allocations.filter(item => item.requirementId === id));
    }
    expect(after.predecessor).toEqual(activeSource(agreed.project));
    expect(repaired.project.proposal!.payload.proposalHash).toBe(hashPlan(after));
    const readiness = deriveReadiness(repaired.project, repaired.project.snapshot.blockTimestamp);
    expect(readiness).toMatchObject({ status: 'awaiting_approval', requiredApprovers: owners, acceptedApprovers: [],
      reasons: owners.map(publisherRoot => ({ code: 'missing_decision', publisherRoot })) });
  });
});
