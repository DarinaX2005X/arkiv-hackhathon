import { describe, expect, it } from 'vitest';
import { parseRoute, routePath } from '../../app/routes';
import { createSessionStore } from '../../app/session';
import { helpTopics } from './catalog';
import { helpContributionRoute, helpHref, helpReturnLabel, helpReturnRoute, isHelpTopic } from './navigation';

describe('contextual Help destinations', () => {
  it('round-trips every topic through the shared router with an exact project return target', () => {
    const project = { name: 'project', projectRoot: 'local:small-works', tab: 'agreement' } as const;
    for (const topic of helpTopics) {
      const route = parseRoute(helpHref(topic.id, project));
      expect(route).toEqual({ name: 'help', topic: topic.id, returnTo: routePath(project) });
      expect(helpReturnRoute('returnTo' in route ? route.returnTo : undefined)).toEqual(project);
    }
  });

  it('keeps a saved draft selected through Help and its return route', () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
    const session = createSessionStore({ storage });
    session.selectDraft('draft-before-help');
    session.navigate({ name: 'new-project' });
    session.navigate(parseRoute(helpHref('publishing', session.currentRoute())));
    const restored = createSessionStore({ storage });
    expect(restored.getSnapshot().activeDraftId).toBe('draft-before-help');
    const route = restored.currentRoute();
    restored.navigate(helpReturnRoute('returnTo' in route ? route.returnTo : undefined));
    expect(restored.getSnapshot()).toMatchObject({ activeDraftId: 'draft-before-help', destination: '/projects/new' });
  });

  it('rejects external, malformed, recursive and unknown return targets', () => {
    for (const destination of ['https://example.org', '//example.org', '#/demo', '/help', '/account', '/sign-in', '/onboarding', '/not-a-route', '/projects/0x123', '/projects/%E0%A4%A']) {
      expect(helpReturnRoute(destination)).toEqual({ name: 'workspace' });
    }
    expect(isHelpTopic('agreement')).toBe(true);
    expect(isHelpTopic('missing-topic')).toBe(false);
    expect(isHelpTopic('<script>')).toBe(false);
  });

  it('preserves the invited project when Help opens contribution preparation', () => {
    const project = { name: 'project', projectRoot: 'local:small-works', tab: 'needs' } as const;
    const contribution = helpContributionRoute(project);
    expect(contribution).toEqual({ name: 'contributions', projectRoot: project.projectRoot, returnTo: routePath(project) });
    const help = parseRoute(helpHref('offers', contribution));
    expect(helpReturnRoute('returnTo' in help ? help.returnTo : undefined)).toEqual(contribution);
    expect(helpContributionRoute(contribution)).toEqual(contribution);
  });

  it('keeps an event destination through sign-in, account and Help detours', () => {
    const event = { name: 'event', projectRoot: `0x${'ab'.repeat(32)}` } as const;
    for (const name of ['sign-in', 'account', 'onboarding', 'help'] as const) {
      const help = parseRoute(helpHref('account', { name, returnTo: routePath(event) }));
      expect(helpReturnRoute('returnTo' in help ? help.returnTo : undefined)).toEqual(event);
    }
    expect(helpReturnLabel(event)).toBe('Back to this event');
    expect(helpReturnLabel({ name: 'events' })).toBe('Back to events');
    expect(helpReturnLabel({ name: 'my-events' })).toBe('Back to my events');
  });
});
