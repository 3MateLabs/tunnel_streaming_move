# Signature Logic Update - Close Authorization

## Summary

Updated the tunnel close logic to properly reflect authorization flow:
- ✅ `close_with_signature()` now requires **payer's signature** (not creator's)
- ✅ Payer-initiated close still uses grace period for full refund

## Changes Made

### 1. Move Module Update

**File**: `move/sources/tunnel.move`

**Function**: `close_with_signature<T>()`

#### Before (Incorrect):
```move
public entry fun close_with_signature<T>(
    tunnel: Tunnel<T>,
    payer_refund: u64,
    creator_payout: u64,
    nonce: u64,
    creator_signature: vector<u8>,  // ❌ Wrong - creator signing
    ctx: &mut TxContext,
) {
    // ...
    // Verify creator's signature
    verify_ed25519_signature(&creator_signature, &tunnel.creator_public_key, &message);
    // ...
}
```

#### After (Correct):
```move
/// Close tunnel immediately with payer's signature
///
/// Creator can close the tunnel immediately if payer signs the close message.
/// This allows agreed-upon settlement without waiting for grace period.
public entry fun close_with_signature<T>(
    tunnel: Tunnel<T>,
    payer_refund: u64,
    creator_payout: u64,
    nonce: u64,
    payer_signature: vector<u8>,  // ✅ Correct - payer authorizes
    ctx: &mut TxContext,
) {
    // ...
    // Verify payer's signature (payer authorizes the close)
    verify_ed25519_signature(&payer_signature, &tunnel.payer_public_key, &message);
    // ...
}
```

### 2. TypeScript Utility Update

**File**: `scripts/src/utils.ts`

**Function**: `signCloseMessage()`

#### Before:
```typescript
export async function signCloseMessage(
  creatorKeypair: Ed25519Keypair,  // ❌ Wrong keypair
  // ...
): Promise<{ signature: Uint8Array; message: Uint8Array }> {
  const signature = await signMessage(creatorKeypair, message);
  // ...
}
```

#### After:
```typescript
/**
 * Sign a close message (for payer to authorize closure terms)
 */
export async function signCloseMessage(
  payerKeypair: Ed25519Keypair,  // ✅ Correct keypair
  tunnelId: string,
  payerRefund: bigint,
  creatorPayout: bigint,
  nonce: bigint,
): Promise<{ signature: Uint8Array; message: Uint8Array }> {
  const signature = await signMessage(payerKeypair, message);
  // ...
}
```

### 3. Test Updates

**Files Updated**:
- `scripts/src/test.ts` - Line 325
- `scripts/src/verify-deletion.ts` - Line 113

#### Before:
```typescript
const { signature } = await signCloseMessage(
  creatorKeypair,  // ❌ Wrong - creator signing
  tunnelId,
  payerRefund,
  creatorPayout,
  nonce,
);
```

#### After:
```typescript
const { signature } = await signCloseMessage(
  payerKeypair,  // ✅ Correct - payer authorizes
  tunnelId,
  payerRefund,
  creatorPayout,
  nonce,
);
```

## Rationale

### Why Payer Must Sign

The corrected logic makes more sense for the business flow:

1. **Payer is Funding**: Payer deposits money into the tunnel
2. **Payer Controls Refund**: Payer should authorize how much they get back
3. **Prevents Unilateral Close**: Creator cannot unilaterally close and take all funds
4. **Mutual Agreement**: Close with signature represents mutual agreement where payer explicitly authorizes the distribution

### Close Flow Options

#### Option 1: Immediate Close with Agreement
**Function**: `close_with_signature<T>()`
- **Who calls**: Creator (anyone can call, but typically creator)
- **Requires**: Payer's signature authorizing the distribution
- **Use case**: Both parties agree on settlement
- **Result**: Immediate close with agreed-upon distribution

```
Creator wants to close:
1. Negotiates terms with payer (off-chain)
2. Payer signs message: tunnel_id || payer_refund || creator_payout || nonce
3. Creator calls close_with_signature() with payer's signature
4. Funds distributed immediately as agreed
```

#### Option 2: Payer-Initiated Close with Grace Period
**Functions**: `init_close<T>()` → wait 60 min → `finalize_close<T>()`
- **Who calls**: Payer initiates, anyone can finalize after grace period
- **Requires**: No signature, but must wait 60 minutes
- **Use case**: Payer wants to exit, creator doesn't respond
- **Result**: After grace period, payer gets full refund

```
Payer wants to close:
1. Calls init_close() - starts 60-minute grace period
2. Waits 60 minutes (creator can respond during this time)
3. Anyone calls finalize_close() after grace period
4. Payer gets full refund (remaining balance after any claims)
```

## Security Implications

### Before (Incorrect Logic)
- ❌ Creator could sign their own close messages
- ❌ Creator could unilaterally close and take funds
- ❌ Payer had no control over close distribution
- ❌ Signature verification was essentially meaningless

### After (Correct Logic)
- ✅ Payer must explicitly authorize any immediate close
- ✅ Creator cannot unilaterally close without payer permission
- ✅ Payer controls the refund amount they receive
- ✅ Signature provides real authorization and security

## Message Format

The close message format remains the same:
```
tunnel_id (32 bytes) || payer_refund (8 bytes) || creator_payout (8 bytes) || nonce (8 bytes)
```

**What changed**: Who signs the message
- Before: Creator signed ❌
- After: Payer signs ✅

## Testing

### All Tests Pass ✅

**Move Tests**: 7/7 passing
```bash
cd move
sui move test
# Test result: OK. Total tests: 7; passed: 7; failed: 0
```

**E2E Tests**: All passing
```bash
cd scripts
npm test
# ✅ All tests completed successfully!
```

**Deletion Tests**: All passing
```bash
cd scripts
npm run verify-deletion
# ✅ Verification complete!
```

### Test Scenarios Covered

1. ✅ Creator closes with payer's signature (immediate)
2. ✅ Payer initiates close (grace period starts)
3. ✅ Payer signature is properly verified
4. ✅ Funds distributed according to signed agreement
5. ✅ Tunnel properly deleted after close

## Deployment

**New Package ID**: `0xd14746e236ce1152e8388f2a3e2696c4b3d611970ef9f8f5a9b644a43ef83d5c`
**Network**: Sui Testnet
**Status**: ✅ Deployed and Tested

**Previous Package** (incorrect logic): `0x1c54bcef49f364f118c455ef5953b4b22f547d40e4abe98765af9290c63ad794`

## Migration Guide

If you have existing code using the old logic:

### Update Function Calls

**Old (incorrect)**:
```typescript
const { signature } = await signCloseMessage(
  creatorKeypair,  // ❌ Wrong
  tunnelId,
  payerRefund,
  creatorPayout,
  nonce,
);
```

**New (correct)**:
```typescript
const { signature } = await signCloseMessage(
  payerKeypair,  // ✅ Correct
  tunnelId,
  payerRefund,
  creatorPayout,
  nonce,
);
```

### Update Package ID

```typescript
// Old package (incorrect signature logic)
const OLD_PACKAGE_ID = '0x1c54bcef49f364f118c455ef5953b4b22f547d40e4abe98765af9290c63ad794';

// New package (correct signature logic)
const NEW_PACKAGE_ID = '0xd14746e236ce1152e8388f2a3e2696c4b3d611970ef9f8f5a9b644a43ef83d5c';
```

## Example Use Case

### Scenario: Content Creator Platform

**Parties**:
- **Payer**: Fan subscribing to creator's content
- **Creator**: Content creator providing exclusive content

**Flow**:

1. **Opening**:
   ```typescript
   // Payer opens tunnel with 10 SUI subscription
   await tx.moveCall({
     target: `${packageId}::tunnel::open_tunnel`,
     typeArguments: ['0x2::sui::SUI'],
     arguments: [creatorConfigId, payerPublicKey, depositCoin],
   });
   ```

2. **Monthly Claims**:
   ```typescript
   // Each month, payer signs claim for that month's fee
   // Creator claims 1 SUI per month
   const signature = await signClaimMessage(
     payerKeypair,
     tunnelId,
     suiToMist(1),  // 1 SUI
     monthNonce,
   );

   await tx.moveCall({
     target: `${packageId}::tunnel::claim`,
     typeArguments: ['0x2::sui::SUI'],
     arguments: [tunnelId, amount, nonce, signature],
   });
   ```

3. **Agreed Early Close**:
   ```typescript
   // After 6 months, both parties agree to close
   // Payer signs authorization: 4 SUI refund, 0 more to creator
   const closeSignature = await signCloseMessage(
     payerKeypair,  // Payer authorizes
     tunnelId,
     suiToMist(4),  // 4 SUI refund to payer
     suiToMist(0),  // 0 additional to creator
     closeNonce,
   );

   await tx.moveCall({
     target: `${packageId}::tunnel::close_with_signature`,
     typeArguments: ['0x2::sui::SUI'],
     arguments: [tunnelId, payerRefund, creatorPayout, nonce, closeSignature],
   });
   ```

4. **Payer-Initiated Close** (if creator unresponsive):
   ```typescript
   // Payer initiates close
   await tx.moveCall({
     target: `${packageId}::tunnel::init_close`,
     typeArguments: ['0x2::sui::SUI'],
     arguments: [tunnelId, clockId],
   });

   // Wait 60 minutes...

   // Anyone can finalize
   await tx.moveCall({
     target: `${packageId}::tunnel::finalize_close`,
     typeArguments: ['0x2::sui::SUI'],
     arguments: [tunnelId, clockId],
   });
   ```

## Benefits of Correct Logic

1. **True Authorization**: Payer's signature actually authorizes the close
2. **Prevents Abuse**: Creator cannot unilaterally drain funds
3. **Fair Dispute Resolution**: Grace period gives payer an exit path
4. **Clear Semantics**: Signature flow makes logical sense
5. **Better Security**: Aligns with principle of least privilege

## Conclusion

The signature logic has been corrected to properly reflect the authorization model:
- ✅ Payer authorizes immediate close by signing
- ✅ Payer can exit via grace period without signatures
- ✅ All tests passing with new logic
- ✅ Deployed to testnet and verified

This change makes the tunnel system more secure and logically consistent with the intended use case of payment channels between payers and creators.

---

**Updated**: 2025-10-26
**New Package**: `0xd14746e236ce1152e8388f2a3e2696c4b3d611970ef9f8f5a9b644a43ef83d5c`
**Status**: ✅ Production Ready
