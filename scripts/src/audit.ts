import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMain } from './utils.js';

const sourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../move/sources/tunnel.move',
);

function requirePattern(source: string, label: string, pattern: RegExp): void {
  if (!pattern.test(source)) throw new Error(`Audit failed: missing ${label}`);
  console.log(`✅ ${label}`);
}

/** Static, read-only audit of the production Move close/claim invariants. */
export async function audit(): Promise<void> {
  const source = await readFile(sourcePath, 'utf8');
  requirePattern(source, 'claim authorization', /sender == tunnel\.creator \|\| sender == tunnel\.operator/);
  requirePattern(source, 'strictly increasing cumulative claims', /cumulative_amount > tunnel\.claimed_amount/);
  requirePattern(source, 'deposit ceiling', /cumulative_amount <= tunnel\.total_deposit/);
  requirePattern(source, 'receipt-to-tunnel binding', /receipt\.tunnel_id == object::uid_to_inner\(&tunnel\.id\)/);
  requirePattern(source, 'payer-only close initiation', /ctx\.sender\(\) == tunnel\.payer/);
  requirePattern(source, 'grace-period enforcement', /current_time >= initiated_at \+ tunnel\.grace_period_ms/);
  requirePattern(source, 'tunnel object deletion', /object::delete\(id\)/);
  console.log('✅ Read-only Move audit passed');
}

runMain(import.meta.url, audit);