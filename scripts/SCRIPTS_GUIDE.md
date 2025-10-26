# Tunnel Scripts Guide

This directory contains TypeScript utilities and scripts for deploying and testing the non-ZK payment tunnel on Sui.

## Prerequisites

```bash
npm install
```

## Available Scripts

### 1. Deploy Script (`npm run deploy`)

Deploys the tunnel Move package to Sui Testnet.

**What it does:**
- Reads creator credentials from `.env`
- Checks account balance (requires minimum 0.1 SUI)
- Builds the Move package
- Publishes to Sui Testnet
- Automatically updates `PACKAGE_ID` in `.env`
- Prints package ID and explorer link

**Usage:**
```bash
npm run deploy
```

**Output:**
```
🚀 Deploying Non-ZK Tunnel to Sui Testnet

Creator Address: 0x...
Balance: 9.825 SUI

📦 Building Move package...
📤 Publishing package...
✅ Transaction successful!
Transaction Digest: ...

📦 Package ID: 0x...
✅ Package ID saved to .env file

🔗 View on explorer:
https://testnet.suivision.xyz/package/0x...

✅ Deployment complete!
```

### 2. Test Script (`npm test`)

Runs comprehensive end-to-end tests on the deployed contract.

**What it does:**
- Tests creator config creation with String metadata
- Tests tunnel opening with deposit (0.01 SUI)
- Tests creator claim with signature (0.005 SUI) - **tunnel closes and deletes automatically**
- Tests tunnel deletion verification
- Tests grace period flow (new tunnel, init + close with signature)

**Usage:**
```bash
npm test
```

**Output:**
```
🧪 Testing Non-ZK Tunnel End-to-End

✅ Test 1: Creator config created
✅ Test 2: Tunnel opened with 0.01 SUI deposit
✅ Test 3: Creator claimed 0.005 SUI (tunnel closed and deleted)
✅ Test 4: Verified tunnel was deleted
✅ Test 5: New tunnel opened and closed with grace period flow

✅ All tests completed successfully!
```

## Utility Functions (`src/utils.ts`)

The `utils.ts` file provides helper functions used by both deploy and test scripts:

### Keypair Management
- `createKeypair(mnemonicOrPrivateKey)` - Create keypair from mnemonic or private key
- `getPublicKey(keypair)` - Extract raw public key bytes

### Message Construction
- `constructClaimMessage(tunnelId, amount, nonce)` - Build claim message
- `constructCloseMessage(tunnelId, payerRefund, creatorPayout, nonce)` - Build close message
- `objectIdToBytes(objectId)` - Convert object ID to 32-byte array

### Signature Operations
- `signMessage(keypair, message)` - Sign with Ed25519 (compatible with Sui)
- `signClaimMessage(payerKeypair, tunnelId, amount, nonce)` - Sign complete claim
- `signCloseMessage(creatorKeypair, tunnelId, payerRefund, creatorPayout, nonce)` - Sign complete close

### Transaction Helpers
- `waitForTransaction(client, digest)` - Wait for tx confirmation
- `getCreatedObjects(txResult)` - Extract created objects from tx result

### Formatting
- `bytesToHex(bytes)` - Convert bytes to hex string
- `hexToBytes(hex)` - Convert hex string to bytes
- `mistToSui(mist)` - Convert MIST to SUI (9 decimals)
- `suiToMist(sui)` - Convert SUI to MIST

## Configuration (`.env`)

```env
# Sui RPC endpoint
SUI_RPC_URL=https://fullnode.testnet.sui.io:443

# Creator credentials (deployer and config creator)
CREATOR_MNEMONIC=your creator mnemonic here

# Payer credentials (opens tunnels and signs claims)
PAYER_MNEMONIC=your payer mnemonic here

# Deployed package ID (auto-updated by deploy script)
PACKAGE_ID=0x...
```

## Development Workflow

### Initial Setup
```bash
# 1. Install dependencies
npm install

# 2. Create .env file with mnemonics
cp .env.example .env
# Edit .env with your mnemonics

# 3. Fund accounts (get testnet SUI from faucet)
# https://faucet.testnet.sui.io/
```

### Deploy & Test
```bash
# Deploy contract
npm run deploy

# Run tests (uses PACKAGE_ID from .env)
npm test
```

### Re-deploy After Changes
```bash
# Make changes to Move code
# Then re-deploy and test
npm run deploy && npm test
```

## TypeScript Compilation

Check for TypeScript errors:
```bash
npx tsc --noEmit
```

## Architecture

```
scripts/
├── src/
│   ├── deploy.ts      # Deployment script
│   ├── test.ts        # End-to-end tests
│   └── utils.ts       # Shared utilities
├── package.json       # NPM scripts and dependencies
├── tsconfig.json      # TypeScript configuration
└── .env              # Environment configuration
```

## Testing Checklist

- ✅ Deploy script builds and publishes successfully
- ✅ Package ID is automatically saved to .env
- ✅ Test 1: Creator config with String metadata
- ✅ Test 2: Tunnel opening
- ✅ Test 3: Claim with signature (tunnel closes and deletes)
- ✅ Test 4: Tunnel deletion verification
- ✅ Test 5: Grace period flow (new tunnel)
- ✅ TypeScript compilation passes
- ✅ All utilities properly exported

## Troubleshooting

### "CREATOR_MNEMONIC not found"
- Ensure `.env` file exists with `CREATOR_MNEMONIC` set

### "Insufficient balance"
- Fund your accounts from https://faucet.testnet.sui.io/
- Minimum 0.1 SUI required for deployment
- Minimum 0.02 SUI required for testing

### "Cannot find package"
- Run `npm run deploy` first to deploy the contract
- Check that `PACKAGE_ID` is set in `.env`

### "Signature verification failed"
- Ensure you're using the correct keypair for signing
- Payer signs claim messages
- Creator signs close messages

## Latest Package

**Current Package ID**: `0x05bed9c9f2617c2a8945dc229df101c398aa56972effe06ced9d411fdf8b3234`

**Network**: Sui Testnet

**Explorer**: https://testnet.suivision.xyz/package/0x05bed9c9f2617c2a8945dc229df101c398aa56972effe06ced9d411fdf8b3234

**Important Change**: The `claim()` function now automatically closes and deletes the tunnel after claiming funds. This simplifies the tunnel lifecycle - for subsequent access, the payer must create a new tunnel.
