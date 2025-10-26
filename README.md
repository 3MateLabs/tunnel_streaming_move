# Tunnel Streaming Move - Generic Payment Channels on Sui

A generic payment tunnel implementation on Sui blockchain using Ed25519 signatures for trustless off-chain payments.

## Overview

This project implements a generic payment tunnel system that supports any coin type on Sui. It enables trustless off-chain payments between a payer and creator using cryptographic signatures, with optional grace periods for dispute resolution.

### Key Features

- **Generic Coin Support**: Works with SUI, USDC, or any Sui coin type via Move generics
- **Ed25519 Signatures**: Secure cryptographic authorization for claims
- **Automatic Cleanup**: Tunnels are automatically deleted after closing
- **Grace Period**: 60-minute dispute window for contested closures
- **Shared Objects**: Efficient concurrent access patterns

## Project Structure

```
tunnel_streaming_move/
├── move/                    # Move smart contracts
│   ├── sources/
│   │   ├── tunnel.move      # Main tunnel module (generic)
│   │   └── tunnel_tests.move
│   └── Move.toml
│
└── scripts/                 # TypeScript deployment & testing
    ├── src/
    │   ├── deploy.ts        # Deployment script
    │   ├── test.ts          # End-to-end tests
    │   ├── verify-deletion.ts  # Deletion verification
    │   └── utils.ts         # Shared utilities
    ├── verify-all.sh        # Comprehensive verification
    ├── package.json
    └── SCRIPTS_GUIDE.md     # Detailed script documentation
```

## Quick Start

### Prerequisites

1. **Sui CLI**: Install from [Sui documentation](https://docs.sui.io/build/install)
2. **Node.js**: v18 or higher
3. **Testnet Funds**: Get SUI from [Sui faucet](https://faucet.testnet.sui.io/)

### Setup

```bash
# 1. Clone repository
git clone <repo-url>
cd tunnel_streaming_move

# 2. Install script dependencies
cd scripts
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your mnemonics

# 4. Deploy contract
npm run deploy

# 5. Run tests
npm test
```

## Module Architecture

### Core Structures

```move
// Generic tunnel supporting any coin type T
public struct Tunnel<phantom T> has key, store {
    id: UID,
    payer: address,
    creator: address,
    payer_public_key: vector<u8>,
    creator_public_key: vector<u8>,
    total_deposit: u64,
    claimed_amount: u64,
    balance: Balance<T>,  // Generic balance
    is_closed: bool,
    close_initiated_at: Option<u64>,
    close_initiated_by: Option<address>,
}

public struct CreatorConfig has key, store {
    id: UID,
    creator: address,
    public_key: vector<u8>,
    metadata: String,
}
```

### Main Functions

1. **`create_creator_config(public_key, metadata)`**
   - Creates a reusable creator configuration
   - Shared object for multiple tunnels

2. **`open_tunnel<T>(creator_config, payer_public_key, deposit)`**
   - Opens a payment tunnel with specified coin type
   - Generic function requiring type argument

3. **`claim<T>(tunnel, amount, nonce, payer_signature)`**
   - Creator claims funds with payer's signature
   - Automatically closes and deletes tunnel

4. **`init_close<T>(tunnel, clock)`**
   - Payer initiates closure (60-minute grace period)

5. **`finalize_close<T>(tunnel, clock)`**
   - Finalizes closure after grace period

6. **`close_with_signature<T>(tunnel, payer_refund, creator_payout, nonce, creator_signature)`**
   - Immediate closure with both parties' agreement

## Generic Type Usage

All tunnel functions require explicit type arguments:

```typescript
// Example: Using with SUI
tx.moveCall({
  target: `${packageId}::tunnel::open_tunnel`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [...]
});

// Example: Using with custom coin
tx.moveCall({
  target: `${packageId}::tunnel::open_tunnel`,
  typeArguments: ['<package_id>::<module>::<CoinType>'],
  arguments: [...]
});
```

## Testing Scripts

### Available Commands

```bash
# Deploy contract to testnet
npm run deploy

# Run end-to-end tests
npm test

# Verify tunnel deletion
npm run verify-deletion

# Run all tests
npm run test:all

# Comprehensive verification (TypeScript + Move + Tests)
./verify-all.sh
```

### Test Coverage

- ✅ Creator config creation
- ✅ Tunnel opening with deposits
- ✅ Claim with Ed25519 signatures
- ✅ Automatic tunnel deletion
- ✅ Grace period flow
- ✅ Signature-based closure
- ✅ Object lifecycle verification

## Current Deployment

**Network**: Sui Testnet
**Package ID**: `0x1c54bcef49f364f118c455ef5953b4b22f547d40e4abe98765af9290c63ad794`
**Explorer**: [View on Sui Vision](https://testnet.suivision.xyz/package/0x1c54bcef49f364f118c455ef5953b4b22f547d40e4abe98765af9290c63ad794)

## Payment Flow

```
┌─────────────┐                    ┌─────────────┐
│   Creator   │                    │    Payer    │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │ 1. create_creator_config()       │
       │───────────────────────────────>  │
       │                                  │
       │                                  │ 2. open_tunnel<T>()
       │                                  │    (deposit funds)
       │  <─────────────────────────────  │
       │                                  │
       │                                  │ 3. Sign claim message
       │                                  │    (off-chain)
       │  <─────────────────────────────  │
       │                                  │
       │ 4. claim<T>()                    │
       │    (with signature)              │
       │    → Tunnel deleted              │
       │                                  │
       ▼                                  ▼
```

## Security Considerations

1. **Ed25519 Signatures**: Industry-standard elliptic curve signatures
2. **Nonce Protection**: Prevents replay attacks
3. **Grace Period**: Allows dispute resolution
4. **Balance Conservation**: Enforced at contract level
5. **Shared Object Safety**: Proper concurrent access patterns

## Development

### Building Move Package

```bash
cd move
sui move build
```

### Running Move Tests

```bash
cd move
sui move test
```

### TypeScript Development

```bash
cd scripts

# Type checking
npx tsc --noEmit

# Run specific test
tsx src/test.ts
tsx src/verify-deletion.ts
```

## Documentation

- [Scripts Guide](./scripts/SCRIPTS_GUIDE.md) - Detailed script documentation
- [Verification Report](./VERIFICATION_REPORT.md) - Initial verification results
- [Move Source](./move/sources/tunnel.move) - Annotated contract code

## Troubleshooting

### Common Issues

**"PACKAGE_ID not found"**
- Run `npm run deploy` first

**"Insufficient balance"**
- Get testnet SUI from https://faucet.testnet.sui.io/

**"TypeScript compilation failed"**
- Run `npm install` to ensure dependencies are installed

**"Signature verification failed"**
- Ensure correct keypair is used (payer signs claims, creator signs closes)

## License

[Your License]

## Contributing

[Your Contribution Guidelines]
