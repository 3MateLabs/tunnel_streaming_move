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

async function testDoubleClose() {
  console.log('🔍 DETAILED INVESTIGATION: Double Close Attack\n');

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

  // Create receiver configs: CreatorA 50%, CreatorB 10%, Referrer 30%, Platform 10%
  const creatorAConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4020),  // RECEIVER_TYPE_CREATOR_ADDRESS
      tx1.pure.address(creatorAddress),
      tx1.pure.u64(4500),  // 45%
    ],
  });

  const creatorBConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4020),  // RECEIVER_TYPE_CREATOR_ADDRESS
      tx1.pure.address(creatorAddress),
      tx1.pure.u64(900),  // 9%
    ],
  });

  const referrerConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4022),  // RECEIVER_TYPE_REFERER_ADDRESS
      tx1.pure.address('0x0'),
      tx1.pure.u64(2700),  // 27%
    ],
  });

  const platformConfig = tx1.moveCall({
    target: `${packageId}::tunnel::create_receiver_config`,
    arguments: [
      tx1.pure.u64(4021),  // Platform type
      tx1.pure.address(creatorAddress),
      tx1.pure.u64(900),  // 9%
    ],
  });

  const receiverConfigs = tx1.makeMoveVec({
    type: `${packageId}::tunnel::ReceiverConfig`,
    elements: [creatorAConfig, creatorBConfig, referrerConfig, platformConfig],
  });

  tx1.moveCall({
    target: `${packageId}::tunnel::create_creator_config`,
    arguments: [
      tx1.pure.address(creatorAddress),
      tx1.pure.vector('u8', Array.from(creatorPublicKey)),
      tx1.pure.string('Test config'),
      receiverConfigs,
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
  const [coin] = tx2.splitCoins(tx2.gas, [suiToMist(0.01)]);
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

  // Close the tunnel
  console.log('💰 FIRST CLOSE: Claiming and closing tunnel...');
  const { signature } = await signClaimMessage(
    payerKeypair,
    tunnelId!,
    suiToMist(0.01),
    BigInt(100)
  );

  const tx3 = new Transaction();
  const [receipt] = tx3.moveCall({
    target: `${packageId}::tunnel::claim`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx3.object(tunnelId!),
      tx3.pure.u64(suiToMist(0.01)),
      tx3.pure.u64(100),
      tx3.pure.vector('u8', Array.from(signature)),
    ],
  });

  tx3.moveCall({
    target: `${packageId}::tunnel::close_with_receipt`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx3.object(tunnelId!),
      receipt,
    ],
  });

  const result3 = await client.signAndExecuteTransaction({
    transaction: tx3,
    signer: creatorKeypair,
    options: { showEffects: true, showObjectChanges: true },
  });

  console.log(`✅ First close succeeded: ${result3.digest}`);
  console.log(`Object changes:`, JSON.stringify(result3.objectChanges, null, 2));

  await waitForTransaction(client, result3.digest);

  // Check if tunnel was deleted
  console.log('\n📊 Checking if tunnel was deleted...');
  try {
    const tunnelCheck = await client.getObject({
      id: tunnelId!,
      options: { showContent: true },
    });
    if (tunnelCheck.error) {
      console.log(`✅ Tunnel deleted: ${tunnelCheck.error.code}`);
    } else {
      console.log(`⚠️  Tunnel still exists!`);
    }
  } catch (e: any) {
    console.log(`✅ Tunnel deleted: ${e.message}`);
  }

  // Try to claim from deleted tunnel
  console.log('\n🔴 DOUBLE CLOSE: Trying to claim from deleted tunnel...');
  const { signature: sig2 } = await signClaimMessage(
    payerKeypair,
    tunnelId!,
    suiToMist(0.01),
    BigInt(101)
  );

  const tx4 = new Transaction();
  tx4.moveCall({
    target: `${packageId}::tunnel::claim`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx4.object(tunnelId!),
      tx4.pure.u64(suiToMist(0.01)),
      tx4.pure.u64(101),
      tx4.pure.vector('u8', Array.from(sig2)),
    ],
  });

  try {
    const result4 = await client.signAndExecuteTransaction({
      transaction: tx4,
      signer: creatorKeypair,
      options: { showEffects: true },
    });

    console.log(`\n🚨 VULNERABILITY! Double close succeeded: ${result4.digest}`);
    console.log('⚠️  CONTRACT ALLOWS OPERATIONS ON DELETED TUNNELS!');
  } catch (error: any) {
    console.log(`\n✅ Double close blocked: ${error.message.substring(0, 200)}`);
    if (error.message.includes('notExists') || error.message.includes('deleted')) {
      console.log('\n✅ Contract correctly prevents double close by deleting the object.');
    }
  }
}

testDoubleClose().catch(console.error);
