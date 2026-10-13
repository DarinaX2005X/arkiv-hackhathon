import { describe, expect, it } from 'vitest';
import { contributionProjectTarget } from '../invitation';

const project = `0x${'a'.repeat(64)}`, proposal = `0x${'b'.repeat(64)}`;

describe('project introductions from pasted invitations', () => {
  it('reads only the project target from links and exact-version invitations', () => {
    for (const input of [project, `#/projects/${project}/needs`, `https://other.example/desk#/projects/${project}/agreement?proposal=${proposal}&hash=${proposal}`,
      `/contributions?projectRoot=${project}&returnTo=${encodeURIComponent(`/projects/${project}/needs`)}`]) {
      expect(contributionProjectTarget(input, 'public')).toBe(project);
    }
    expect(contributionProjectTarget('local:festival', 'local')).toBe('local:festival');
    expect(contributionProjectTarget('#/projects/local:festival/agreement', 'local')).toBe('local:festival');
  });
  it('rejects malformed, ambiguous, credential-bearing and wrong-mode references', () => {
    for (const input of ['local:festival', 'javascript:alert(1)', `https://user:pass@site.example/#/projects/${project}`, `//other.example/#/projects/${project}`,
      `#/projects/${project}/agreement#extra`, `#/projects/${project}?proposal=invalid`, `#/projects/${project}?proposal=${proposal}&revision=${proposal}`,
      `#/projects/${project}?hash=bad`, `#/projects/${project}?proposal=${proposal}&proposal=${proposal}`, `#/projects/${project}?private=secret`,
      `/contributions?projectRoot=${project}&returnTo=https://other.example`, `#/publishers/${project}`, '#/%zz', `${project}\nprivate`, 'x'.repeat(2049)]) {
      expect(contributionProjectTarget(input, 'public'), input).toBeNull();
    }
    expect(contributionProjectTarget(project, 'local')).toBeNull();
    expect(contributionProjectTarget(`/contributions?projectRoot=${project}&projectRoot=${proposal}`, 'public')).toBeNull();
  });
});
