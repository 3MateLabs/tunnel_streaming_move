import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createKeypair,
  getPublicKey,
  signClaimMessage,
  suiToMist,
  getCreatedObjects,
  waitForTransaction,
} from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function detailedTest() {
  console.log('🔍 DETAILED INVESTIGATION: Signature Replay Attack\n');

  const envPath = path.join(__dirname, '../.env');
  const envContent = readFileSync(envPath, 'utf-8');
  const env = Object.fromEntries(
    envContent.split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('=').map(s => s.trim()))
  );

  const rpcUrl = env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
  const packageId = env.PACKAGE_ID;
  const creatorMnemonic = env.CREATOR_MNEMONIC;
  const payerMnemonic = env.PAYER_MNEMONIC;

  const client = new SuiClient({ url: rpcUrl });
  const creatorKeypair = createKeypair(creatorMnemonic);
  const payerKeypair = createKeypair(payerMnemonic);
  const creatorPublicKey = getPublicKey(creatorKeypair);
  const payerPublicKey = getPublicKey(payerKeypair);
  const creatorAddress = creatorKeypair.toSuiAddress();

  // Setup
  console.log('Setting up config and tunnel...');

  const tx1 = new Transaction();
  tx1.moveCall({
    target: `${packageId}::tunnel::create_creator_config`,
    arguments: [
      tx1.pure.address(creatorAddress),
      tx1.pure.address(creatorAddress),
      tx1.pure.vector('u8', Array.from(creatorPublicKey)),
      tx1.pure.string('Test config'),
      tx1.pure.u64(500),
      tx1.pure.u64(200),
      tx1.pure.address(creatorAddress),
      tx1.pure.u64(1000),
    ],
  });

  const result1 = await client.signAndExecuteTransaction({
    transaction: tx1,
    signer: creatorKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  await waitForTransaction(client, result1.digest);

  const configId = getCreatedObjects(result1).find(obj =>
    obj.objectType.includes('CreatorConfig')
  )?.objectId;

  const tx2 = new Transaction();
  const [coin] = tx2.splitCoins(tx2.gas, [suiToMist(0.1)]);
  tx2.moveCall({
    target: `${packageId}::tunnel::open_tunnel`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx2.object(configId!),
      tx2.pure.vector('u8', Array.from(payerPublicKey)),
      tx2.pure.vector('u8', []),  // credential: empty for tests
      tx2.pure.address('0x0'),
      coin,
    ],
  });

  const result2 = await client.signAndExecuteTransaction({
    transaction: tx2,
    signer: payerKeypair,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });

  await waitForTransaction(client, result2.digest);

  const tunnelId = getCreatedObjects(result2).find(obj =>
    obj.objectType.includes('Tunnel')
  )?.objectId;

  console.log(`✅ Setup complete. Tunnel: ${tunnelId}\n`);

  // Check tunnel state before first claim
  console.log('📊 Checking tunnel state BEFORE first claim...');
  const tunnelBefore = await client.getObject({
    id: tunnelId!,
    options: { showContent: true },
  });
  console.log('Tunnel content:', JSON.stringify((tunnelBefore.data?.content as any)?.fields, null, 2));
  console.log('');

  // First claim
  console.log('💰 FIRST CLAIM: Claiming 0.01 SUI with nonce 1...');
  const claimAmount = suiToMist(0.01);
  const nonce = BigInt(1);
  const { signature } = await signClaimMessage(payerKeypair, tunnelId!, claimAmount, nonce);

  const tx3 = new Transaction();
  tx3.moveCall({
    target: `${packageId}::tunnel::claim`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx3.object(tunnelId!),
      tx3.pure.u64(claimAmount),
      tx3.pure.u64(nonce),
      tx3.pure.vector('u8', Array.from(signature)),
    ],
  });

  try {
    const result3 = await client.signAndExecuteTransaction({
      transaction: tx3,
      signer: creatorKeypair,
      options: { showEffects: true, showEvents: true },
    });

    console.log(`✅ First claim succeeded: ${result3.digest}`);
    console.log(`Status: ${(result3.effects as any)?.status?.status}`);
    console.log('');
  } catch (error: any) {
    console.log(`❌ First claim failed: ${error.message}`);
    return;
  }

  // Wait for transaction to finalize
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check tunnel state after first claim
  console.log('📊 Checking tunnel state AFTER first claim...');
  const tunnelAfter1 = await client.getObject({
    id: tunnelId!,
    options: { showContent: true },
  });
  console.log('Tunnel content:', JSON.stringify((tunnelAfter1.data?.content as any)?.fields, null, 2));
  console.log('');

  // Second claim - REPLAY ATTACK
  console.log('🔴 REPLAY ATTACK: Trying to reuse same signature...');
  console.log(`   Using same amount (${claimAmount}) and nonce (${nonce})`);

  const tx4 = new Transaction();
  tx4.moveCall({
    target: `${packageId}::tunnel::claim`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx4.object(tunnelId!),
      tx4.pure.u64(claimAmount),
      tx4.pure.u64(nonce),
      tx4.pure.vector('u8', Array.from(signature)),
    ],
  });

  try {
    const result4 = await client.signAndExecuteTransaction({
      transaction: tx4,
      signer: creatorKeypair,
      options: { showEffects: true, showEvents: true },
    });

    console.log(`\n🚨 VULNERABILITY! Replay attack succeeded: ${result4.digest}`);
    console.log(`Status: ${(result4.effects as any)?.status?.status}`);

    // Check if funds were actually drained
    const tunnelAfter2 = await client.getObject({
      id: tunnelId!,
      options: { showContent: true },
    });
    console.log('\n📊 Tunnel state after replay:');
    console.log('Tunnel content:', JSON.stringify((tunnelAfter2.data?.content as any)?.fields, null, 2));
    console.log('');
    console.log('⚠️  CONTRACT IS VULNERABLE TO SIGNATURE REPLAY!');
  } catch (error: any) {
    console.log(`\n✅ Replay attack blocked: ${error.message.substring(0, 200)}`);
    console.log('\n✅ Contract correctly prevents signature replay.');
  }
}

detailedTest().catch(console.error);
