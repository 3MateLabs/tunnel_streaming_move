import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'src');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

test('executable Sui scripts use only the SDK2 gRPC/Core transport', async () => {
  const files = await sourceFiles(sourceRoot);
  const joined = (await Promise.all(files.map(async (file) =>
    `\n// ${path.relative(root, file)}\n${await readFile(file, 'utf8')}`
  ))).join('\n');

  const forbidden: Array<[string, RegExp]> = [
    ['SuiClient value import', /import\s+\{[^}]*\bSuiClient\b[^}]*\}\s+from\s+['"]@mysten\/sui\/client['"]/],
    ['JSON-RPC package', /@mysten\/sui\/(?:jsonRpc|client\/json-rpc)/i],
    ['public fullnode endpoint', /https:\/\/fullnode\.[^'"\s]+/i],
    ['legacy RPC environment variable', /SUI_RPC_URL/],
    ['legacy transaction submission call', /(?<!core)\.signAndExecuteTransaction\s*\(/],
    ['legacy wait call', /(?<!core)\.waitForTransaction\s*\(/],
    ['legacy object request shape', /\.getObject\s*\(\s*\{\s*id\s*:/],
    ['legacy balance call', /(?<!core)\.getBalance\s*\(/],
  ];

  for (const [label, pattern] of forbidden) {
    assert.doesNotMatch(joined, pattern, label);
  }

  assert.match(joined, /import\s+\{\s*SuiGrpcClient\s*\}\s+from\s+['"]@mysten\/sui\/grpc['"]/);
  assert.match(joined, /new\s+SuiGrpcClient\s*\(\s*\{[\s\S]*?network\s*:\s*['"]testnet['"][\s\S]*?baseUrl(?:\s*:|\s*,)/);
  assert.match(joined, /\.core\.waitForTransaction\s*\(/);

  const entrypoints = files.filter((file) => path.basename(file) !== 'utils.ts');
  for (const file of entrypoints) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /runMain\(import\.meta\.url,\s*\w+\);/, `${path.basename(file)} main guard`);
  }

  for (const file of entrypoints.filter((file) => path.basename(file).startsWith('audit'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /@mysten\/sui\/transactions|executeAndConfirm|signer\s*:|moveCall\s*\(/,
      `${path.basename(file)} must be read-only`);
    assert.doesNotMatch(source, /MNEMONIC|PRIVATE_KEY|SECRET_KEY/,
      `${path.basename(file)} must not load credentials`);
  }
});
