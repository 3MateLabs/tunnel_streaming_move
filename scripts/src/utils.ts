import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { toB64 } from '@mysten/sui/utils';

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

/**
 * Wait for transaction confirmation
 */
export async function waitForTransaction(
  client: SuiClient,
  digest: string,
): Promise<any> {
  console.log(`Waiting for transaction: ${digest}`);

  const result = await client.waitForTransaction({
    digest,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  if (result.effects?.status.status !== 'success') {
    throw new Error(`Transaction failed: ${result.effects?.status.error}`);
  }

  return result;
}

/**
 * Get created objects from transaction result
 */
export function getCreatedObjects(txResult: any): Array<{ objectId: string; objectType: string }> {
  const created: Array<{ objectId: string; objectType: string }> = [];

  if (txResult.objectChanges) {
    for (const change of txResult.objectChanges) {
      if (change.type === 'created') {
        created.push({
          objectId: change.objectId,
          objectType: change.objectType,
        });
      }
    }
  }

  return created;
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
