import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMain } from './utils.js';

const sourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../move/sources/tunnel.move',
);

/** Read-only source audit proving close consumes and deletes the tunnel. */
export async function auditDoubleClose(): Promise<void> {
  const source = await readFile(sourcePath, 'utf8');
  const closeStart = source.indexOf('public fun close_with_receipt');
  const helperStart = source.indexOf('fun close_tunnel_and_refund');
  if (closeStart < 0 || helperStart < 0) throw new Error('Close implementation was not found');

  const closeBody = source.slice(closeStart, source.indexOf('\n}', closeStart) + 2);
  const helperBody = source.slice(helperStart, source.indexOf('\n}', helperStart) + 2);
  if (!closeBody.includes('receipt.tunnel_id == object::uid_to_inner(&tunnel.id)')) {
    throw new Error('Close receipt is not bound to the tunnel ID');
  }
  if (!closeBody.includes('close_tunnel_and_refund(') || !helperBody.includes('object::delete(id)')) {
    throw new Error('Close does not consume and delete the tunnel');
  }
  console.log('✅ Read-only double-close audit passed');
}

runMain(import.meta.url, auditDoubleClose);