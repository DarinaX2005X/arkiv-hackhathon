import { describe, expect, it } from 'vitest';
import { connectWallet } from '../wallet';
import type { InjectedWalletProvider, RpcRequest } from '../wallet';

const account = '0x1111111111111111111111111111111111111111';
const network = '0x7614d1';
const cancelled = { kind: 'not_sent', code: 'not_connected' };

function wallet(answer?: (request: RpcRequest) => Promise<unknown>) {
  const calls: RpcRequest[] = [];
  const provider: InjectedWalletProvider = { request: async request => {
    calls.push(request);
    if (answer) return answer(request);
    if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [account];
    if (request.method === 'eth_chainId') return network;
    throw new Error('Unexpected wallet prompt or signature request.');
  } };
  return { provider, methods: () => calls.map(call => call.method) };
}

describe('wallet connection cancellation', () => {
  it('requests an account explicitly but avoids a network prompt when already on Tiramisu', async () => {
    const f = wallet();
    await expect(connectWallet(f.provider)).resolves.toEqual({ account, chainId: 7738577 });
    expect(f.methods()).toEqual(['eth_requestAccounts', 'eth_chainId', 'eth_accounts', 'eth_chainId']);
  });

  it('does not contact the provider if the originating dialog is already closed', async () => {
    const f = wallet();
    await expect(connectWallet(f.provider, { isCurrent: () => false })).rejects.toMatchObject(cancelled);
    expect(f.methods()).toEqual([]);
  });

  it('ignores a late account approval after its dialog was closed', async () => {
    let current = true, resolveAccounts: (value: unknown) => void = () => {};
    const f = wallet(async () => new Promise(resolve => { resolveAccounts = resolve; }));
    const pending = connectWallet(f.provider, { isCurrent: () => current });
    current = false;
    resolveAccounts([account]);
    await expect(pending).rejects.toMatchObject(cancelled);
    expect(f.methods()).toEqual(['eth_requestAccounts']);
  });

  it('does not request a network switch after cancellation during its passive network read', async () => {
    let current = true;
    const f = wallet(async request => {
      if (request.method === 'eth_requestAccounts') return [account];
      current = false;
      return '0x1';
    });
    await expect(connectWallet(f.provider, { isCurrent: () => current })).rejects.toMatchObject(cancelled);
    expect(f.methods()).toEqual(['eth_requestAccounts', 'eth_chainId']);
  });

  it('does not add a network after a cancelled unknown-chain reply', async () => {
    let current = true;
    const f = wallet(async request => {
      if (request.method === 'eth_requestAccounts') return [account];
      if (request.method === 'eth_chainId') return '0x1';
      current = false;
      throw Object.assign(new Error('Unknown network.'), { code: 4902 });
    });
    await expect(connectWallet(f.provider, { isCurrent: () => current })).rejects.toMatchObject(cancelled);
    expect(f.methods()).toEqual(['eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain']);
  });

  it('does not issue a second switch after the add-network approval arrives too late', async () => {
    let current = true;
    const f = wallet(async request => {
      if (request.method === 'eth_requestAccounts') return [account];
      if (request.method === 'eth_chainId') return '0x1';
      if (request.method === 'wallet_switchEthereumChain') throw Object.assign(new Error('Unknown network.'), { code: 4902 });
      current = false;
      return null;
    });
    await expect(connectWallet(f.provider, { isCurrent: () => current })).rejects.toMatchObject(cancelled);
    expect(f.methods()).toEqual(['eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']);
  });

  it('adds an unknown network only during the active explicit connection and validates it afterwards', async () => {
    let known = false, chain = '0x1';
    const f = wallet(async request => {
      if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [account];
      if (request.method === 'eth_chainId') return chain;
      if (request.method === 'wallet_addEthereumChain') { known = true; return null; }
      if (!known) throw Object.assign(new Error('Unknown network.'), { code: 4902 });
      chain = network;
      return null;
    });
    await expect(connectWallet(f.provider, { isCurrent: () => true })).resolves.toEqual({ account, chainId: 7738577 });
    expect(f.methods()).toEqual(['eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain',
      'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_accounts', 'eth_chainId']);
  });

  it('cannot grant the account returned by an approval if the provider has since changed accounts', async () => {
    const f = wallet(async request => request.method === 'eth_requestAccounts' ? [account]
      : request.method === 'eth_accounts' ? ['0x2222222222222222222222222222222222222222'] : network);
    await expect(connectWallet(f.provider)).rejects.toMatchObject(cancelled);
    expect(f.methods().some(method => /send|sign|switch|add/i.test(method))).toBe(false);
  });
});
