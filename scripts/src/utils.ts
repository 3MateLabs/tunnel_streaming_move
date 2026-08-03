import type { SuiClientTypes } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Prevent imported scripts from executing and ensure top-level failures exit non-zero. */
export function isMainModule(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined
    && path.resolve(entrypoint) === path.resolve(fileURLToPath(metaUrl));
}

export function runMain(metaUrl: string, main: () => Promise<void>): void {
  if (!isMainModule(metaUrl)) return;
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

/**
 * Create a keypair from mnemonic or private key
 */
export function createKeypair(mnemonicOrPrivateKey: string): Ed25519Keypair {
  // Check if it's a hex private key
  if (mnemonicOrPrivateKey.startsWith('0x') || mnemonicOrPrivateKey.length === 64) {
    const privateKey = mnemonicOrPrivateKey.startsWith('0x')
      ? mnemonicOrPrivateKey.slice(2)
      : mnemonicOrPrivateKey;
    return Ed25519Keypair.fromSecretKey(Buffer.from(privateKey, 'hex'));
  }

  // Otherwise treat as mnemonic
  return Ed25519Keypair.deriveKeypair(mnemonicOrPrivateKey);
}

/**
 * Get public key from keypair
 */
export function getPublicKey(keypair: Ed25519Keypair): Uint8Array {
  return keypair.getPublicKey().toRawBytes();
}

/**
 * Construct claim message: tunnel_id || amount || nonce
 */
export function constructClaimMessage(
  tunnelId: Uint8Array,
  amount: bigint,
  nonce: bigint,
): Uint8Array {
  const amountBytes = bcs.u64().serialize(amount).toBytes();
  const nonceBytes = bcs.u64().serialize(nonce).toBytes();

  const message = new Uint8Array(tunnelId.length + amountBytes.length + nonceBytes.length);
  message.set(tunnelId, 0);
  message.set(amountBytes, tunnelId.length);
  message.set(nonceBytes, tunnelId.length + amountBytes.length);

  return message;
}

/**
 * Construct close message: tunnel_id || payer_refund || creator_payout || nonce
 */
export function constructCloseMessage(
  tunnelId: Uint8Array,
  payerRefund: bigint,
  creatorPayout: bigint,
  nonce: bigint,
): Uint8Array {
  const payerRefundBytes = bcs.u64().serialize(payerRefund).toBytes();
  const creatorPayoutBytes = bcs.u64().serialize(creatorPayout).toBytes();
  const nonceBytes = bcs.u64().serialize(nonce).toBytes();

  const message = new Uint8Array(
    tunnelId.length + payerRefundBytes.length + creatorPayoutBytes.length + nonceBytes.length
  );
  message.set(tunnelId, 0);
  message.set(payerRefundBytes, tunnelId.length);
  message.set(creatorPayoutBytes, tunnelId.length + payerRefundBytes.length);
  message.set(nonceBytes, tunnelId.length + payerRefundBytes.length + creatorPayoutBytes.length);

  return message;
}

/**
 * Sign a message with Ed25519 keypair
 * Following the pattern from giverep_claim reference implementation
 */
export async function signMessage(
  keypair: Ed25519Keypair,
  message: Uint8Array,
): Promise<Uint8Array> {
  // Use keypair.sign() directly on the message bytes
  // This returns a Uint8Array signature that's compatible with ed25519::ed25519_verify
  const signature = await keypair.sign(message);
  return signature;
}

/**
 * Convert object ID string to bytes
 */
export function objectIdToBytes(objectId: string): Uint8Array {
  // Remove '0x' prefix if present
  const hex = objectId.startsWith('0x') ? objectId.slice(2) : objectId;

  // Pad to 32 bytes (64 hex chars)
  const paddedHex = hex.padStart(64, '0');

  // Convert to bytes
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(paddedHex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

/**
 * Sign a claim message (for creator to claim funds)
 */
export async function signClaimMessage(
  payerKeypair: Ed25519Keypair,
  tunnelId: string,
  amount: bigint,
  nonce: bigint,
): Promise<{ signature: Uint8Array; message: Uint8Array }> {
  const tunnelIdBytes = objectIdToBytes(tunnelId);
  const message = constructClaimMessage(tunnelIdBytes, amount, nonce);
  const signature = await signMessage(payerKeypair, message);

  return { signature, message };
}

/**
 * Sign a close message (for payer to authorize closure terms)
 */
export async function signCloseMessage(
  payerKeypair: Ed25519Keypair,
  tunnelId: string,
  payerRefund: bigint,
  creatorPayout: bigint,
  nonce: bigint,
): Promise<{ signature: Uint8Array; message: Uint8Array }> {
  const tunnelIdBytes = objectIdToBytes(tunnelId);
  const message = constructCloseMessage(tunnelIdBytes, payerRefund, creatorPayout, nonce);
  const signature = await signMessage(payerKeypair, message);

  return { signature, message };
}

/**
 * Format bytes as hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse hex string to bytes
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

type TransactionStatus = {
  success: boolean;
  error?: { message?: string } | null;
};

type TransactionLike = {
  digest: string;
  status: TransactionStatus;
};

type TransactionResultLike<T extends TransactionLike> =
  | { $kind: 'Transaction'; Transaction: T; FailedTransaction?: never }
  | { $kind: 'FailedTransaction'; Transaction?: never; FailedTransaction: T };

function requireSuccessfulTransaction<T extends TransactionLike>(
  result: TransactionResultLike<T>,
): T {
  const transaction = result.$kind === 'Transaction'
    ? result.Transaction
    : result.FailedTransaction;

  if (result.$kind === 'FailedTransaction' || !transaction.status.success) {
    throw new Error(transaction.status.error?.message ?? 'Transaction execution failed');
  }

  return transaction;
}

/**
 * Submit, confirm finality, reject failed status, and require digest equality.
 * Callers must not expose stream/session/UI success before this resolves.
 */
export async function confirmTransactionWorkflow<
  Submitted extends TransactionLike,
  Confirmed extends TransactionLike,
>(
  submit: () => Promise<TransactionResultLike<Submitted>>,
  wait: (digest: string) => Promise<TransactionResultLike<Confirmed>>,
): Promise<Confirmed> {
  const submitted = requireSuccessfulTransaction(await submit());
  const confirmed = requireSuccessfulTransaction(await wait(submitted.digest));

  if (confirmed.digest !== submitted.digest) {
    throw new Error(
      `Transaction digest mismatch: submitted ${submitted.digest}, confirmed ${confirmed.digest}`,
    );
  }

  return confirmed;
}

const transactionInclude = {
  effects: true,
  events: true,
  objectTypes: true,
} as const;

type ConfirmedTransaction = SuiClientTypes.Transaction<typeof transactionInclude>;

type LegacyObjectChange = {
  type: 'created' | 'deleted' | 'mutated';
  objectId: string;
  objectType: string;
};

export type TunnelTransaction = ConfirmedTransaction & {
  objectChanges: LegacyObjectChange[];
};

export function getSuiGrpcUrl(env: Record<string, string>): string {
  const value = env.SUI_GRPC_URL;
  if (!value) {
    throw new Error('SUI_GRPC_URL is required and must point to a Sui gRPC service');
  }

  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('SUI_GRPC_URL must use HTTPS');
  }
  return url.toString();
}

function legacyObjectChanges(transaction: ConfirmedTransaction): LegacyObjectChange[] {
  return transaction.effects.changedObjects.map((change) => ({
    type: change.idOperation === 'Created'
      ? 'created'
      : change.idOperation === 'Deleted'
        ? 'deleted'
        : 'mutated',
    objectId: change.objectId,
    objectType: transaction.objectTypes[change.objectId]
      ?? (change.outputState === 'PackageWrite' ? 'package' : 'unknown'),
  }));
}

/** SDK2 gRPC/Core client boundary used by every executable script. */
export class TunnelClient {
  readonly core: SuiGrpcClient['core'];
  readonly #confirmedDigests = new Set<string>();

  constructor(baseUrl: string) {
    const client = new SuiGrpcClient({
      network: 'testnet',
      baseUrl,
    });
    this.core = client.core;
  }

  async executeAndConfirm(input: {
    transaction: Transaction;
    signer: Signer;
    options?: unknown;
  }): Promise<TunnelTransaction> {
    const confirmed = await confirmTransactionWorkflow<
      ConfirmedTransaction,
      ConfirmedTransaction
    >(
      () => this.core.signAndExecuteTransaction({
        transaction: input.transaction,
        signer: input.signer,
        include: transactionInclude,
      }),
      (digest) => this.core.waitForTransaction({
        digest,
        include: transactionInclude,
      }),
    );

    this.#confirmedDigests.add(confirmed.digest);

    return Object.assign(confirmed, {
      objectChanges: legacyObjectChanges(confirmed),
    });
  }

  async balance(owner: string): Promise<{ totalBalance: string }> {
    const response = await this.core.getBalance({ owner });
    return { totalBalance: response.balance.balance };
  }

  assertFinalized(digest: string): void {
    if (!this.#confirmedDigests.has(digest)) {
      throw new Error(`Transaction ${digest} has not passed strict confirmation`);
    }
  }

  async object(input: { id: string; options?: unknown }): Promise<{
    data: {
      objectId: string;
      content: { dataType: 'moveObject'; fields: Record<string, unknown> } | null;
    };
    error?: { code: string };
  }> {
    const { object } = await this.core.getObject({
      objectId: input.id,
      include: { json: true },
    });
    return {
      data: {
        objectId: object.objectId,
        content: object.json
          ? { dataType: 'moveObject', fields: object.json }
          : null,
      },
    };
  }
}

export async function assertFinalizedDigest(
  client: TunnelClient,
  digest: string,
): Promise<void> {
  client.assertFinalized(digest);
}

/** Get created objects from a strictly confirmed transaction. */
export function getCreatedObjects(
  txResult: TunnelTransaction,
): Array<{ objectId: string; objectType: string }> {
  return txResult.objectChanges
    .filter((change) => change.type === 'created')
    .map(({ objectId, objectType }) => ({ objectId, objectType }));
}

/**
 * Format MIST to SUI
 */
export function mistToSui(mist: bigint | string): string {
  const mistBigInt = typeof mist === 'string' ? BigInt(mist) : mist;
  return (Number(mistBigInt) / 1_000_000_000).toFixed(9);
}

/**
 * Format SUI to MIST
 */
export function suiToMist(sui: number): bigint {
  return BigInt(Math.floor(sui * 1_000_000_000));
}
