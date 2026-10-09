import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import ts from 'typescript';
import { createPublicRuntime } from '../app/network';
import type { StoragePort } from '../app/storage';
import { createArkivRepository } from '../data/arkiv';
import type { InjectedWalletProvider } from '../data/wallet/types';
import { KEYS, NOW, PUBLISHER, entityKey, readyFixture } from '../data/__tests__/arkiv-fixture';
import { TIRAMISU_CHAIN_ID } from '../domain/types';
import { createDeskNavigation } from './navigation';
import { deskPath, invitationStatus, parseDeskRoute, parsePublicTarget } from './routes';

function memoryStorage(): StoragePort {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function fakeWallet() {
  const calls: string[] = []; const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider: InjectedWalletProvider = {
    request: async args => {
      calls.push(args.method);
      if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') return [PUBLISHER];
      if (args.method === 'eth_chainId') return `0x${TIRAMISU_CHAIN_ID.toString(16)}`;
      if (args.method === 'wallet_switchEthereumChain') return null;
      throw new Error(`Unexpected wallet method: ${args.method}`);
    },
    on: (event, listener) => { const current = listeners.get(event) ?? new Set(); current.add(listener); listeners.set(event, current); },
    removeListener: (event, listener) => { listeners.get(event)?.delete(listener); },
  };
  return { calls, provider, listeners, emit: (event: string) => listeners.get(event)?.forEach(listener => listener()) };
}

describe('Partner Desk invitation boundary', () => {
  it('accepts generated public project links and all shared contribution destinations', () => {
    for (const section of ['needs', 'plans', 'agreement', 'runbook', 'history']) {
      expect(parseDeskRoute(`https://studio.example/app/#/projects/${KEYS.project}/${section}`)).toMatchObject({ name: 'project', projectRoot: KEYS.project });
    }
    expect(parseDeskRoute('#/requests')).toEqual({ name: 'requests' });
    expect(parseDeskRoute('#/contributions')).toEqual({ name: 'contributions' });
    expect(parsePublicTarget(KEYS.project, 'project')).toEqual({ name: 'project', projectRoot: KEYS.project, section: 'agreement' });
    expect(parsePublicTarget(KEYS.publisher, 'publisher')).toEqual({ name: 'publisher', publisherRoot: KEYS.publisher });
  });
  it('preserves exact invitation constraints and an offer identity in round trips', () => {
    const invitation = `#/projects/${KEYS.project}/agreement?activation=${KEYS.activation}&proposal=${KEYS.proposal}&hash=${entityKey(99)}`;
    expect(parseDeskRoute(deskPath(parseDeskRoute(invitation)))).toEqual(parseDeskRoute(invitation));
    expect(parseDeskRoute(`#/projects/${KEYS.project}?revision=${KEYS.proposal}`)).toMatchObject({ revision: { proposalKey: KEYS.proposal } });
    const offer = parseDeskRoute(`#/publishers/${KEYS.publisher}?offer=hall-weekday`);
    expect(offer).toEqual({ name: 'publisher', publisherRoot: KEYS.publisher, offerId: 'hall-weekday' });
    expect(parseDeskRoute(deskPath(offer))).toEqual(offer);
  });
  it('rejects local IDs, unsupported application routes, malformed and ambiguous inputs', () => {
    const invalid = ['#/projects/local:library/agreement', 'local:hall', '#/demo', '#/workspace', '#/projects/new', '#/%zz', 'javascript:alert(1)', '//evil.test/x',
      `#/projects/${KEYS.project}?activation=${KEYS.activation}&activation=${KEYS.activation}`, `#/projects/${KEYS.project}?revision=local:old`,
      `#/projects/${KEYS.project}?revision=${KEYS.proposal}&proposal=${KEYS.proposal}`, `#/projects/${KEYS.project}?secret=private`,
      `https://user:pass@other.test/#/projects/${KEYS.project}`, `#/publishers/${KEYS.publisher}?offer=../private`, `#/projects/${KEYS.project}/agreement#extra`];
    for (const value of invalid) expect(parsePublicTarget(value, 'project'), value).toEqual({ name: 'not-found' });
  });
  it('never treats an old activation as the invited current revision', async () => {
    const fixture = readyFixture(); const rpc = fixture.rpc;
    const read = await createArkivRepository({ request: rpc.request, now: () => NOW }).loadProject(KEYS.project);
    if (!read.ok) throw new Error('Invalid test fixture');
    expect(invitationStatus(read.value, { activationKey: KEYS.activation, proposalKey: KEYS.proposal, proposalHash: fixture.proposal.proposalHash })).toBe('current');
    expect(invitationStatus(read.value, { activationKey: entityKey(987) })).toBe('different');
    expect(invitationStatus({ ...read.value, activation: { status: 'missing', reason: 'not_found' } }, { proposalKey: KEYS.proposal })).toBe('unavailable');
  });
  it('keeps project needs available before a proposal and mounts them outside agreement gating', async () => {
    const fixture = readyFixture();
    fixture.rpc.remove(KEYS.proposal); fixture.rpc.remove(KEYS.activation);
    const read = await createArkivRepository({ request: fixture.rpc.request, now: () => NOW }).loadProject(KEYS.project);
    if (!read.ok || read.value.state.status !== 'unique') throw new Error('Preproposal project could not be read');
    expect(read.value.proposal).toBeNull();
    expect(read.value.state.entity.payload.recipe).toEqual(fixture.state.recipe);
    expect(read.value.state.entity.payload.recipe.variants.flatMap(variant => variant.requirements).length).toBeGreaterThan(0);
    expect(parseDeskRoute(`#/projects/${KEYS.project}/needs`)).toMatchObject({ name: 'project', projectRoot: KEYS.project });
    const source = readFileSync(resolve(import.meta.dirname, 'DeskApp.tsx'), 'utf8');
    const parsed = ts.createSourceFile('DeskApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const view = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ProjectView');
    const needsGates: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === 'ProjectNeeds') {
        const conditional = node.parent;
        if (ts.isBinaryExpression(conditional) && conditional.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) needsGates.push(conditional.left.getText(parsed));
      }
      ts.forEachChild(node, visit);
    };
    if (!view) throw new Error('The project route is missing'); visit(view);
    expect(needsGates).toEqual(['visibleProject']);
    expect(source).toContain("from '../features/projects/ProjectNeeds'");
  });
});

describe('independent Desk runtime and invitation restoration', () => {
  it('retains the destination through connection, disconnect, reload and unrelated Studio navigation', async () => {
    const storage = memoryStorage(); const wallet = fakeWallet(); const rpc = readyFixture().rpc;
    const hash = `#/projects/${KEYS.project}/agreement?activation=${KEYS.activation}&proposal=${KEYS.proposal}`;
    const navigation = createDeskNavigation(storage, hash); navigation.remember();
    const desk = createPublicRuntime({ storage, namespace: 'partfolk:partner-desk', provider: wallet.provider, request: rpc.request, now: () => NOW });
    const studio = createPublicRuntime({ storage, namespace: 'partfolk:studio', provider: wallet.provider, request: rpc.request, now: () => NOW });
    expect(wallet.calls).toEqual([]);
    expect(await desk.connect()).toBe(true);
    expect(studio.runtime.session.getSnapshot().actor).toBeNull();
    studio.runtime.session.navigate({ name: 'home' }); desk.disconnect();
    expect(deskPath(navigation.getSnapshot())).toBe(hash.slice(1));
    expect(createDeskNavigation(storage, '').getSnapshot()).toEqual(navigation.getSnapshot());
    expect(createDeskNavigation(storage, '#/requests').getSnapshot()).toEqual({ name: 'requests' });
    desk.dispose(); studio.dispose();
  });
  it('reads directly with no wallet and clears only its own account event listeners', async () => {
    const storage = memoryStorage(); const wallet = fakeWallet(); const rpc = readyFixture().rpc;
    const first = createPublicRuntime({ storage, namespace: 'test:desk', provider: wallet.provider, request: rpc.request, now: () => NOW });
    const second = createPublicRuntime({ storage, namespace: 'test:studio', provider: wallet.provider, request: rpc.request, now: () => NOW });
    expect((await first.runtime.repository!.loadProject(KEYS.project)).ok).toBe(true);
    expect(wallet.calls).toEqual([]);
    expect(await first.connect()).toBe(true); expect(await second.connect()).toBe(true);
    first.disconnect(); expect(second.runtime.session.getSnapshot().actor).toMatchObject({ kind: 'wallet', address: PUBLISHER });
    wallet.emit('accountsChanged'); expect(second.runtime.session.getSnapshot().actor).toBeNull();
    first.dispose(); second.dispose();
    expect([...wallet.listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(wallet.calls.some(method => /send|sign/i.test(method))).toBe(false);
    expect(rpc.calls.some(call => call.method === 'arkiv_query')).toBe(true);
  });
});

describe('standalone production source graph', () => {
  it('does not pull in the Studio entry, router shell, local demo adapter or server endpoints', () => {
    const root = resolve(import.meta.dirname, '..', '..');
    const visited = new Set<string>(); const queue = [resolve(root, 'src/desk/main.tsx')];
    while (queue.length) {
      const path = queue.pop()!; if (visited.has(path)) continue; visited.add(path);
      const source = readFileSync(path, 'utf8');
      expect(source, relative(root, path)).not.toMatch(/(?:fetch|axios\.(?:get|post))\s*\(\s*['"`]\/api\//);
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const node of file.statements) {
        if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
        if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) continue;
        if (ts.isExportDeclaration(node) && node.isTypeOnly) continue;
        if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const specifier = node.moduleSpecifier.text;
        if (!specifier.startsWith('.') || /\.(?:css|woff2|svg)$/.test(specifier)) continue;
        const target = resolve(dirname(path), specifier);
        const resolved = [target, `${target}.ts`, `${target}.tsx`, resolve(target, 'index.ts'), resolve(target, 'index.tsx')].find(candidate => existsSync(candidate) && /\.[cm]?[jt]sx?$/.test(candidate));
        if (!resolved) throw new Error(`Unresolved runtime import: ${path} -> ${specifier}`);
        queue.push(resolved);
      }
    }
    const files = [...visited].map(path => relative(root, path).replaceAll('\\', '/'));
    expect(files).toContain('src/app/network.ts'); expect(files).toContain('src/data/arkiv/repository.ts');
    expect(files).toContain('src/features/contributions/Agreement.tsx');
    expect(files).toContain('src/features/projects/ProjectNeeds.tsx');
    expect(files.some(path => /src\/app\/(?:main|App|Studio|studio)\./.test(path) || path.startsWith('src/data/local') || path === 'src/domain/fixtures.ts')).toBe(false);
  });
});
