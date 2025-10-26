import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createKeypair, waitForTransaction, getCreatedObjects } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function deploy() {
  console.log('🚀 Deploying Non-ZK Tunnel to Sui Testnet\n');

  // Load environment variables
  const envPath = path.join(__dirname, '../.env');
  let env: Record<string, string> = {};

  try {
    const envContent = readFileSync(envPath, 'utf-8');
    env = Object.fromEntries(
      envContent.split('\n')
        .filter(line => line && !line.startsWith('#'))
        .map(line => line.split('=').map(s => s.trim()))
    );
  } catch (error) {
    console.error('⚠️  No .env file found. Using defaults.');
  }

  const rpcUrl = env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
  const creatorMnemonic = env.CREATOR_MNEMONIC;

  if (!creatorMnemonic) {
    console.error('❌ CREATOR_MNEMONIC not found in .env file');
    console.log('Please create a .env file with CREATOR_MNEMONIC');
    process.exit(1);
  }

  // Create client and keypair
  const client = new SuiClient({ url: rpcUrl });
  const creatorKeypair = createKeypair(creatorMnemonic);
  const creatorAddress = creatorKeypair.toSuiAddress();

  console.log(`Creator Address: ${creatorAddress}`);

  // Check balance
  const balance = await client.getBalance({ owner: creatorAddress });
  console.log(`Balance: ${Number(balance.totalBalance) / 1_000_000_000} SUI\n`);

  if (BigInt(balance.totalBalance) < BigInt(100_000_000)) {
    console.error('❌ Insufficient balance. Please fund your account:');
    console.log(`https://faucet.testnet.sui.io/ with address: ${creatorAddress}`);
    process.exit(1);
  }

  // Build the Move package
  console.log('📦 Building Move package...');
  const movePath = path.join(__dirname, '../../move');

  try {
    execSync('sui move build', {
      cwd: movePath,
      stdio: 'inherit',
    });
  } catch (error) {
    console.error('❌ Failed to build Move package');
    process.exit(1);
  }

  // Read compiled modules
  console.log('\n📤 Publishing package...');
  const compiledModulesPath = path.join(movePath, 'build/tunnel/bytecode_modules');
  const modules: string[] = [];

  try {
    const fs = await import('fs');
    const files = fs.readdirSync(compiledModulesPath);

    for (const file of files) {
      if (file.endsWith('.mv')) {
        const modulePath = path.join(compiledModulesPath, file);
        const moduleBytes = fs.readFileSync(modulePath);
        modules.push(Array.from(moduleBytes).toString());
      }
    }
  } catch (error) {
    console.error('❌ Failed to read compiled modules:', error);
    process.exit(1);
  }

  // Create publish transaction
  const tx = new Transaction();
  const [upgradeCap] = tx.publish({
    modules: modules.map(m => Array.from(m.split(',').map(Number))),
    dependencies: [
      '0x1', // Sui framework
      '0x2', // Sui system
    ],
  });

  tx.transferObjects([upgradeCap], creatorAddress);

  // Sign and execute
  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: creatorKeypair,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
      },
    });

    console.log(`\n✅ Transaction successful!`);
    console.log(`Transaction Digest: ${result.digest}`);

    // Find package ID
    const createdObjects = getCreatedObjects(result);
    const packageObj = createdObjects.find(obj => obj.objectType === 'package');

    if (packageObj) {
      const packageId = packageObj.objectId;
      console.log(`\n📦 Package ID: ${packageId}`);

      // Update .env file
      const envContent = readFileSync(envPath, 'utf-8');
      const updatedEnv = envContent.replace(
        /PACKAGE_ID=.*/,
        `PACKAGE_ID=${packageId}`
      );

      if (!envContent.includes('PACKAGE_ID=')) {
        writeFileSync(envPath, envContent + `\nPACKAGE_ID=${packageId}\n`);
      } else {
        writeFileSync(envPath, updatedEnv);
      }

      console.log(`\n✅ Package ID saved to .env file`);
      console.log(`\n🔗 View on explorer:`);
      console.log(`https://testnet.suivision.xyz/package/${packageId}`);
    }

  } catch (error) {
    console.error('❌ Failed to publish package:', error);
    process.exit(1);
  }

  console.log('\n✅ Deployment complete!');
}

deploy().catch(console.error);
