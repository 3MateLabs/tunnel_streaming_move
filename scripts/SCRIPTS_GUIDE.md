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

### 3. Verify Deletion Script (`npm run verify-deletion`)

Specifically tests that tunnels are properly deleted after closing.

**What it does:**
- Creates a creator config
- Opens a new tunnel with 0.01 SUI
- Verifies tunnel exists before closing
- Closes tunnel with signature
- Verifies tunnel is deleted from chain

**Usage:**
```bash
npm run verify-deletion
```

### 4. Run All Tests (`npm run test:all`)

Runs both the basic tests and deletion verification.

**Usage:**
```bash
npm run test:all
```

### 5. Verify All Script (`./verify-all.sh`)

Comprehensive verification script that checks everything.

**What it does:**
- Checks Node.js and npm are installed
- Installs dependencies if needed
- Validates `.env` file exists
- Runs TypeScript compilation check
- Builds Move package
- **Runs Move unit tests (7 tests)**
- Verifies package ID is set
- Runs all TypeScript tests (basic + deletion verification)

**Usage:**
```bash
./verify-all.sh
```

**Output includes:**
```
✓ Checking Node.js...
✓ Checking npm...
✓ Checking dependencies...
✓ Checking .env file...
✓ Checking TypeScript compilation...
✓ Checking Move package build...
✓ Running Move unit tests...          ← 7 Move tests
✓ Checking package ID in .env...
✓ Running basic end-to-end tests...   ← TypeScript E2E
✓ Running deletion verification test... ← Deletion tests

✅ All verifications passed!
```

### 6. Move Unit Tests (Direct)

Run Move unit tests directly without TypeScript tests.

**What it does:**
- Tests message construction helpers
- Tests BCS encoding
- Tests message determinism
- 7 unit tests covering core functions

**Usage:**
```bash
cd ../move
sui move test
```

**Output:**
```
[ PASS    ] tunnel::tunnel_tests::test_bcs_u64_encoding
[ PASS    ] tunnel::tunnel_tests::test_close_message_different_amounts
[ PASS    ] tunnel::tunnel_tests::test_construct_claim_message
[ PASS    ] tunnel::tunnel_tests::test_construct_close_message
[ PASS    ] tunnel::tunnel_tests::test_different_inputs_different_messages
[ PASS    ] tunnel::tunnel_tests::test_different_tunnel_ids
[ PASS    ] tunnel::tunnel_tests::test_message_deterministic
Test result: OK. Total tests: 7; passed: 7; failed: 0
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
│   ├── deploy.ts           # Deployment script
│   ├── test.ts             # End-to-end tests
│   ├── verify-deletion.ts  # Deletion verification test
│   └── utils.ts            # Shared utilities
├── package.json            # NPM scripts and dependencies
├── tsconfig.json           # TypeScript configuration
├── verify-all.sh           # Comprehensive verification script
├── SCRIPTS_GUIDE.md        # This guide
└── .env                    # Environment configuration
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

**Current Package ID**: `0x1c54bcef49f364f118c455ef5953b4b22f547d40e4abe98765af9290c63ad794`

**Network**: Sui Testnet

**Explorer**: https://testnet.suivision.xyz/package/0x1c54bcef49f364f118c455ef5953b4b22f547d40e4abe98765af9290c63ad794

**Important Changes**:
1. The `claim()` function now automatically closes and deletes the tunnel after claiming funds. This simplifies the tunnel lifecycle - for subsequent access, the payer must create a new tunnel.
2. **Generic Coin Support**: The Tunnel module now supports any coin type via generics (`Tunnel<T>`). All functions require a type argument:
   - For SUI: `typeArguments: ['0x2::sui::SUI']`
   - For other coins: `typeArguments: ['<package>::<module>::<CoinType>']`

## Generic Type Support

The Tunnel module uses Move generics to support any coin type on Sui:

```typescript
// Example: Opening a tunnel with SUI
tx.moveCall({
  target: `${packageId}::tunnel::open_tunnel`,
  typeArguments: ['0x2::sui::SUI'],  // Specify coin type
  arguments: [
    tx.object(creatorConfigId),
    tx.pure.vector('u8', Array.from(payerPublicKey)),
    coin,
  ],
});

// Example: Opening a tunnel with USDC
tx.moveCall({
  target: `${packageId}::tunnel::open_tunnel`,
  typeArguments: ['0x2::usdc::USDC'],  // Different coin type
  arguments: [
    tx.object(creatorConfigId),
    tx.pure.vector('u8', Array.from(payerPublicKey)),
    usdcCoin,
  ],
});
```

All generic functions require `typeArguments`:
- `open_tunnel<T>`
- `claim<T>`
- `init_close<T>`
- `finalize_close<T>`
- `close_with_signature<T>`
