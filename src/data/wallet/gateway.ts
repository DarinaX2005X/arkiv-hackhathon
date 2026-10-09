import { createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { bytes32, i32, key, str, u64 } from '@arkiv-network/sdk/attr';
import type { AttributeInputs } from '@arkiv-network/sdk/attr';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { custom } from 'viem';
import type { Hex } from 'viem';
import { canonicalJson } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { AccountAddress, DecimalString, TransactionHash } from '../../domain/types';
import type {
  InjectedWalletProvider, NativeBatch, NativeTransactionOptions, NativeTransactionRequest,
  NativeWalletGateway, PreparedNativeBatch, RpcRequest, RpcRequester,
} from './types';
import { WalletOperationError } from './types';

export const ARKIV_NATIVE_ADDRESS = '0x4400000000000000000000000000000000000044' as const;
const CHAIN_HEX = '0x7614d1';
const sendMethods = new Set(['eth_sendTransaction', 'wallet_sendTransaction']);
const addressPattern = /^0x[\da-fA-F]{40}$/;
const keyPattern = /^0x[\da-fA-F]{64}$/;
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const fail = (message: string, code: ConstructorParameters<typeof WalletOperationError>[1]['code'] = 'invalid_input') =>
  new WalletOperationError(message, { kind: 'not_sent', code });

function decimal(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw fail('Expected an unsigned decimal integer.');
  return BigInt(value);
}
function rpcInteger(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]+$/.test(value)) throw fail('The RPC returned an invalid integer.', 'network');
  return BigInt(value);
}
function providerCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
}

/** Uses only public SDK constructors; the SDK itself creates the native execute calldata. */
function sdkBatch(batch: NativeBatch) {
  if (!(batch.creates?.length || batch.deletes?.length || batch.extensions?.length)) throw fail('The native batch is empty.');
  const creates = (batch.creates ?? []).map(create => {
    if (canonicalJson(JSON.parse(create.payloadJson)) !== create.payloadJson) throw fail('Entity JSON must be canonical.');
    if (!Number.isSafeInteger(create.lifetimeSeconds) || create.lifetimeSeconds <= 0) throw fail('Invalid entity lifetime.');
    const salt = decimal(create.salt);
    if (salt >= 2n ** 128n) throw fail('The entity salt exceeds uint128.');
    const attributes: Record<string, AttributeInputs[string]> = {};
    for (const [name, attribute] of Object.entries(create.attributes)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw fail('Attribute names must be lowercase.');
      switch (attribute.type) {
        case 'str': attributes[name] = str(attribute.value); break;
        case 'i32': attributes[name] = i32(attribute.value); break;
        case 'u64': attributes[name] = u64(decimal(attribute.value)); break;
        case 'key': attributes[name] = key(attribute.value); break;
        case 'bytes32': attributes[name] = bytes32(attribute.value); break;
        default: throw fail('Unsupported native attribute type.');
      }
    }
    return {
      payload: new TextEncoder().encode(create.payloadJson), contentType: 'application/json',
      attributes, expires: ExpirationTime.fromSeconds(create.lifetimeSeconds), salt,
      flags: { readonly: true, permissionlessExtension: false },
    };
  });
  const deletes = (batch.deletes ?? []).map(entityKey => {
    if (!keyPattern.test(entityKey)) throw fail('A native delete requires a public entity key.');
    return { entityKey };
  });
  const extensions = (batch.extensions ?? []).map(extension => {
    if (!keyPattern.test(extension.entityKey)) throw fail('A native extension requires a public entity key.');
    return { entityKey: extension.entityKey, expires: ExpirationTime.atBlock(decimal(extension.expiresAtBlock)) };
  });
  return { creates, deletes, extensions };
}

function txParams(options: NativeTransactionOptions) {
  if (options.gasPrice !== undefined && (options.maxFeePerGas !== undefined || options.maxPriorityFeePerGas !== undefined)) {
    throw fail('Legacy and EIP-1559 fee fields cannot be mixed.');
  }
  const gas = options.gas === undefined ? undefined : decimal(options.gas);
  if (gas === 0n) throw fail('A gas limit must be positive.');
  if (options.gasPrice !== undefined) return { gas, gasPrice: decimal(options.gasPrice) };
  const maxFeePerGas = options.maxFeePerGas === undefined ? undefined : decimal(options.maxFeePerGas);
  const maxPriorityFeePerGas = options.maxPriorityFeePerGas === undefined ? undefined : decimal(options.maxPriorityFeePerGas);
  if (maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas > maxFeePerGas) {
    throw fail('The priority fee cannot exceed the maximum fee.');
  }
  return { gas, maxFeePerGas, maxPriorityFeePerGas };
}

function envelope(args: RpcRequest, account: AccountAddress): NativeTransactionRequest {
  const raw = args.params?.[0];
  if (typeof raw !== 'object' || raw === null) throw fail('The SDK produced an invalid transaction.');
  const tx = raw as Record<string, unknown>;
  if (typeof tx.from !== 'string' || tx.from.toLowerCase() !== account.toLowerCase()
    || typeof tx.to !== 'string' || tx.to.toLowerCase() !== ARKIV_NATIVE_ADDRESS.toLowerCase()
    || typeof tx.data !== 'string' || !/^0x(?:[\da-fA-F]{2})+$/.test(tx.data)
    || (tx.chainId !== undefined && rpcInteger(tx.chainId) !== BigInt(TIRAMISU_CHAIN_ID))
    || (tx.value !== undefined && rpcInteger(tx.value) !== 0n)) throw fail('The transaction does not match its wallet authority.');
  const result: NativeTransactionRequest = {
    from: account.toLowerCase() as AccountAddress, to: ARKIV_NATIVE_ADDRESS, data: tx.data as Hex,
    value: '0x0', chainId: CHAIN_HEX,
  };
  const fees = ['gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const;
  for (const name of fees) if (tx[name] !== undefined) result[name] = `0x${rpcInteger(tx[name]).toString(16)}`;
  if (Object.keys(tx).some(name => !['from', 'to', 'data', 'value', 'chainId', ...fees].includes(name))) {
    throw fail('The SDK produced unsupported transaction fields.');
  }
  return result;
}

async function assertWallet(provider: InjectedWalletProvider, account: AccountAddress): Promise<void> {
  const [accounts, chain] = await Promise.all([
    provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' }),
  ]);
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== account.toLowerCase()) {
    throw fail('The connected wallet account changed. Reconnect before continuing.', 'not_connected');
  }
  if (rpcInteger(chain) !== BigInt(TIRAMISU_CHAIN_ID)) throw fail('Switch the wallet to Arkiv Tiramisu.', 'wrong_chain');
}

/** Connect from a user action. This requests an account/network, never an entity signature. */
export async function connectWallet(provider: InjectedWalletProvider): Promise<{ account: AccountAddress; chainId: typeof TIRAMISU_CHAIN_ID }> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof account !== 'string' || !addressPattern.test(account)) throw fail('Connect a valid EOA wallet account.', 'not_connected');
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] }); }
  catch (error) {
    if (providerCode(error) !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{
      chainId: CHAIN_HEX, chainName: tiramisu.name, nativeCurrency: tiramisu.nativeCurrency,
      rpcUrls: [tiramisu.rpcUrls.default.http[0]], blockExplorerUrls: ['https://tiramisu.explorer.arkiv.network'],
    }] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  }
  await assertWallet(provider, account as AccountAddress);
  return { account: account.toLowerCase() as AccountAddress, chainId: TIRAMISU_CHAIN_ID };
}

export function createWalletGateway(options: {
  provider: InjectedWalletProvider; publicRpc: RpcRequester; onSessionChange?: () => void;
}): NativeWalletGateway {
  const { provider, publicRpc } = options;
  let invalidated = false;
  let sending = false;
  const invalidate = () => { invalidated = true; options.onSessionChange?.(); };
  const events = ['accountsChanged', 'chainChanged', 'disconnect'] as const;
  for (const event of events) provider.on?.(event, invalidate);
  const assertCurrent = () => { if (invalidated) throw fail('The wallet session changed. Reconnect before continuing.', 'not_connected'); };

  return {
    async prepare(batchInput, account, optionInput = {}) {
      const batch = clone(batchInput);
      const transactionOptions = clone(optionInput);
      if (!addressPattern.test(account)) throw fail('Invalid wallet account.');
      account = account.toLowerCase() as AccountAddress;
      const sdkInput = sdkBatch(batch);
      const params = txParams(transactionOptions);
      if (rpcInteger(await publicRpc.request({ method: 'eth_chainId' })) !== BigInt(TIRAMISU_CHAIN_ID)) {
        throw fail('The public RPC is not Arkiv Tiramisu.', 'wrong_chain');
      }
      const block = rpcInteger(await publicRpc.request({ method: 'eth_blockNumber' }));
      let captured: NativeTransactionRequest | undefined;
      const transport = custom({ request: async (args: RpcRequest) => {
        if (sendMethods.has(args.method)) {
          captured = envelope(args, account);
          throw new Error('Partfolk unsigned transaction captured.');
        }
        if (args.method === 'eth_chainId') return CHAIN_HEX;
        if (args.method === 'eth_blockNumber') return `0x${block.toString(16)}`;
        throw fail('Unexpected SDK method during unsigned preparation.', 'unsupported');
      } }, { retryCount: 0 });
      const client = createWalletClient({ account, chain: tiramisu, transport, cacheTime: 0 });
      try { await client.executeBatch(sdkInput, params); }
      catch (error) { if (!captured) throw error; }
      if (!captured) throw fail('The SDK did not produce transaction data.');
      const { chainId: _chain, ...estimateRequest } = captured;
      const estimatedGas = rpcInteger(await publicRpc.request({ method: 'eth_estimateGas', params: [estimateRequest] }));
      if (estimatedGas <= 0n) throw fail('The RPC returned an invalid gas estimate.', 'network');
      if (params.gas !== undefined && params.gas < estimatedGas) throw fail('The frozen gas limit is below the current estimate.');
      let price = params.gasPrice ?? params.maxFeePerGas ?? null;
      if (price === null) {
        try { price = rpcInteger(await publicRpc.request({ method: 'eth_gasPrice' })); }
        catch { /* A missing fee quote is explicitly represented, never reported as zero. */ }
      }
      const cap = params.gasPrice ?? params.maxFeePerGas;
      return {
        batch, account, chainId: TIRAMISU_CHAIN_ID, transactionOptions, request: captured,
        estimatedGas: estimatedGas.toString() as DecimalString, preparedAtBlock: block.toString() as DecimalString,
        estimatedCostWei: price === null ? null : (estimatedGas * price).toString() as DecimalString,
        estimatedMaximumCostWei: params.gas !== undefined && cap !== undefined ? (params.gas * cap).toString() as DecimalString : null,
        estimatePolicy: params.gas !== undefined && cap !== undefined ? 'explicit-cap' : price === null ? 'gas-only' : 'estimate-only',
      };
    },

    async submit(preparedInput, hooks) {
      const prepared = clone(preparedInput);
      if (sending) throw fail('Another wallet submission is already in progress.', 'conflict');
      assertCurrent();
      sending = true;
      let forwarded = false;
      let returnedHash: TransactionHash | undefined;
      let hashSaved = false;
      let rawFailure: unknown;
      let localFailure: unknown;
      try {
        const sdkInput = sdkBatch(prepared.batch);
        const params = txParams(prepared.transactionOptions);
        await assertWallet(provider, prepared.account);
        assertCurrent();
        // An explicit gas limit bypasses the wallet's usual estimate. Check those exact bytes
        // again now so a stale predecessor is rejected before asking for a funded send.
        if (params.gas !== undefined) {
          const { chainId: _chain, ...request } = prepared.request;
          const estimate = rpcInteger(await publicRpc.request({ method: 'eth_estimateGas', params: [request] }));
          if (estimate <= 0n || estimate > params.gas) throw fail('The current estimate no longer fits the frozen gas limit.');
        }
        const transport = custom({ request: async (args: RpcRequest) => {
          if (sendMethods.has(args.method)) {
            if (forwarded) throw new Error('Partfolk blocked an additional wallet send.');
            try {
              const request = envelope(args, prepared.account);
              if (canonicalJson(request) !== canonicalJson(prepared.request)) throw fail('The transaction changed after preparation.');
              await assertWallet(provider, prepared.account);
              assertCurrent();
              await hooks.onAdmission(clone(request));
              assertCurrent();
            } catch (error) { localFailure = error; throw error; }
            forwarded = true;
            let response: unknown;
            // Viem omits chainId for JSON-RPC accounts. Pin it explicitly in our forwarded
            // envelope, after checking the provider, so the journal is the exact send request.
            try { response = await provider.request({ method: args.method, params: [clone(prepared.request)] }); }
            catch (error) { rawFailure = error; throw error; }
            if (typeof response !== 'string' || !keyPattern.test(response)) {
              rawFailure = new Error('The wallet returned an invalid transaction hash.');
              throw rawFailure;
            }
            returnedHash = response as TransactionHash;
            try { await hooks.onHash(returnedHash); hashSaved = true; }
            catch (error) { localFailure = error; throw error; }
            // The SDK wraps this sentinel, but the saved hash is already the durable handoff.
            throw new Error('Partfolk transaction hash captured; receipt verification is separate.');
          }
          if (args.method === 'eth_chainId') return provider.request(args);
          if (args.method === 'eth_blockNumber') return publicRpc.request(args);
          throw fail('Unexpected SDK method during transaction submission.', 'unsupported');
        } }, { retryCount: 0 });
        const client = createWalletClient({ account: prepared.account, chain: tiramisu, transport, cacheTime: 0 });
        try { await client.executeBatch(sdkInput, params); }
        catch (error) {
          if (returnedHash && hashSaved) return { status: 'submitted', transactionHash: returnedHash };
          const rawCode = providerCode(rawFailure);
          if (rawCode === 4001) throw new WalletOperationError('The wallet rejected the transaction.', { kind: 'rejected', code: 'rejected', providerCode: rawCode, cause: rawFailure });
          if (!forwarded && localFailure instanceof WalletOperationError) throw localFailure;
          throw new WalletOperationError(forwarded ? 'The transaction needs verification before another submission.' : 'The transaction was not sent.', {
            kind: forwarded ? 'unverified' : 'not_sent', code: forwarded ? 'unverified' : 'network',
            providerCode: rawCode, transactionHash: returnedHash, cause: rawFailure ?? localFailure ?? error,
          });
        }
        throw fail('The SDK completed without a captured transaction hash.', 'unverified');
      } catch (error) {
        if (error instanceof WalletOperationError) throw error;
        throw new WalletOperationError(forwarded ? 'The transaction needs verification before another submission.' : 'The transaction was not sent.', {
          kind: forwarded ? 'unverified' : 'not_sent', code: forwarded ? 'unverified' : 'network', transactionHash: returnedHash, cause: error,
        });
      } finally { sending = false; }
    },
    dispose() {
      invalidated = true;
      for (const event of events) provider.removeListener?.(event, invalidate);
    },
  };
}
