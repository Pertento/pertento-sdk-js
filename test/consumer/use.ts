// Typechecked by `bun run typecheck:consumer` after a build, the way a customer's project sees
// the package: resolved by name through package.json "exports", with nodenext resolution and
// no Bun types. Never run.
import { createPertento, type Decision, type PertentoError, type TrackResult } from '@pertentoai/sdk';

export async function example(): Promise<string> {
  const pertento = createPertento({
    websiteId: 1,
    serverKey: 'psk_live_example',
    pollIntervalMs: 30_000,
    fetch: globalThis.fetch,
  });
  await pertento.ready();
  const visitorId = pertento.createVisitorId();
  const decision: Decision = await pertento.getVariant('new-checkout', { visitorId, attributes: { plan: 'pro' } });
  const all: Record<string, Decision> = await pertento.getAll({ id: 'customer-42' });
  const result: TrackResult = await pertento.track('purchase', { visitorId, data: { revenue: 4900 } });
  const error: PertentoError | null = result.ok ? pertento.lastError : result.error;
  pertento.close();
  return `${pertento.seedScript([decision, ...Object.values(all)], visitorId, { nonce: 'abc' })}${error?.kind ?? ''}`;
}
