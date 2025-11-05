import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromB64 } from '@mysten/sui/utils';

/**
 * Generate Ed25519 keypair for operator
 *
 * The operator uses this keypair to sign claim messages off-chain.
 * The public key is stored in CreatorConfig and Tunnel for signature verification.
 */
async function generateKeypair() {
  console.log('🔑 Generating Ed25519 Keypair for Operator\n');
  console.log('This keypair is used for:');
  console.log('  - Operator signs claim messages off-chain');
  console.log('  - Public key stored in CreatorConfig for verification');
  console.log('  - Private key kept secret by operator\n');
  console.log('='.repeat(70));

  // Generate new keypair
  const keypair = new Ed25519Keypair();

  // Get public key (32 bytes)
  const publicKey = keypair.getPublicKey().toRawBytes();
  const publicKeyHex = '0x' + Buffer.from(publicKey).toString('hex');

  // Get private key
  const privateKeyB64 = keypair.getSecretKey();
  const privateKeyBytes = fromB64(privateKeyB64);
  const privateKeyHex = '0x' + Buffer.from(privateKeyBytes).toString('hex');

  // Get Sui address
  const suiAddress = keypair.toSuiAddress();

  console.log('\n📋 Keypair Details:\n');
  console.log(`Sui Address:      ${suiAddress}`);
  console.log(`Public Key (hex): ${publicKeyHex}`);
  console.log(`Public Key (b64): ${Buffer.from(publicKey).toString('base64')}`);
  console.log(`\n🔐 KEEP THIS SECRET:`);
  console.log(`Private Key (hex): ${privateKeyHex}`);
  console.log(`Private Key (b64): ${privateKeyB64}`);

  console.log('\n='.repeat(70));
  console.log('\n💡 Usage:');
  console.log('  1. Store private key securely (never share it!)');
  console.log('  2. Use public key when creating CreatorConfig');
  console.log('  3. Use private key to sign claim messages off-chain');
  console.log('\n📝 Example in TypeScript:');
  console.log(`  const operatorKeypair = Ed25519Keypair.fromSecretKey("${privateKeyB64}");`);
  console.log(`  const operatorPublicKey = "${publicKeyHex}";`);
  console.log('\n');
}

generateKeypair().catch(console.error);
