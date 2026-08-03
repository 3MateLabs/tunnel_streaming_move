import { TunnelClient, getSuiGrpcUrl, runMain } from './utils.js';

/** Read-only gRPC inspection of an existing tunnel; never opens credential files. */
export async function detailedAudit(): Promise<void> {
  const env: Record<string, string> = {};
  if (process.env.SUI_GRPC_URL) env.SUI_GRPC_URL = process.env.SUI_GRPC_URL;
  const tunnelId = process.env.TUNNEL_ID;
  if (!tunnelId) throw new Error('TUNNEL_ID is required for the read-only detailed audit');

  const tunnel = await new TunnelClient(getSuiGrpcUrl(env)).object({ id: tunnelId });
  const fields = tunnel.data.content?.fields;
  if (!fields) throw new Error(`Tunnel ${tunnelId} has no readable Move JSON`);

  for (const field of ['payer', 'creator', 'operator', 'total_deposit', 'claimed_amount', 'balance']) {
    if (!(field in fields)) throw new Error(`Tunnel ${tunnelId} is missing field ${field}`);
  }
  console.log(`✅ Read-only tunnel audit passed for ${tunnel.data.objectId}`);
}

runMain(import.meta.url, detailedAudit);
