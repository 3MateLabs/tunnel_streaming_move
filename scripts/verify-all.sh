#!/bin/bash

# Verification script for tunnel scripts
# Checks that all scripts work correctly

set -e  # Exit on error

echo "🔍 Verifying Tunnel Scripts"
echo "================================"
echo ""

# Check Node.js
echo "✓ Checking Node.js..."
node --version || { echo "❌ Node.js not found"; exit 1; }

# Check npm
echo "✓ Checking npm..."
npm --version || { echo "❌ npm not found"; exit 1; }

# Check dependencies
echo "✓ Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "  Installing dependencies..."
    npm install
fi

# Check .env file
echo "✓ Checking .env file..."
if [ ! -f ".env" ]; then
    echo "❌ .env file not found"
    echo "  Please create .env with CREATOR_MNEMONIC and PAYER_MNEMONIC"
    exit 1
fi

# Check TypeScript compilation
echo "✓ Checking TypeScript compilation..."
npx tsc --noEmit || { echo "❌ TypeScript compilation failed"; exit 1; }

# Check Move package
echo "✓ Checking Move package..."
cd ../move
sui move build > /dev/null 2>&1 || { echo "❌ Move build failed"; exit 1; }
cd ../scripts

# Check package ID
echo "✓ Checking package ID in .env..."
if ! grep -q "PACKAGE_ID=0x" .env; then
    echo "⚠️  PACKAGE_ID not set in .env"
    echo "  Run 'npm run deploy' first"
fi

# Run deploy (commented out by default to avoid unnecessary deployments)
# echo "✓ Testing deploy script..."
# npm run deploy > /dev/null 2>&1 || { echo "❌ Deploy script failed"; exit 1; }

# Run tests
echo "✓ Running tests..."
npm test || { echo "❌ Tests failed"; exit 1; }

echo ""
echo "================================"
echo "✅ All verifications passed!"
echo ""
echo "Available scripts:"
echo "  npm run deploy  - Deploy contract to testnet"
echo "  npm test        - Run end-to-end tests"
echo ""
echo "Current package: $(grep PACKAGE_ID .env | cut -d= -f2)"
