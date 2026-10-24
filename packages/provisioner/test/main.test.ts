import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeSigner, workloadKeyFor } from '@moca/control-plane';
import { seedSettler } from '../src/main.js';
import { parseSandboxSpec, putWorkload, type ProvisionerDeps } from '../src/provisioner.js';
import { BundleStore } from '../src/seed.js';
import { FakeKube, workloadTemplate } from './fake-kube.js';

// The seed-settle loop main.ts runs: once at startup, then while anything may still seed.

const signer = makeSigner(
  generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
);
const config = {
  maxPerWorkload: 2,
  maxPerOwner: 4,
  attachTtlS: 86400,
  storage: { maxMiB: 10 * 1024, classes: new Map() },
  seedUrl: 'http://moca-provisioner.moca.svc:8081/seed/v1/bundle',
  maxEntries: 10_000,
};

describe('the seed-settle loop (main.ts)', () => {
  it('after a restart (nothing held) still settles a seed that finishes, while the annotation is on', async () => {
    const kube = new FakeKube();
    kube.objects.podtemplates.set('moca-workload-sandbox', workloadTemplate());
    const deps: ProvisionerDeps = { kube, signer, config, bundles: new BundleStore(1024 * 1024) };
    const r = { owner: 'github:alice', name: 'demo', generation: randomUUID() };
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    const spec = parseSandboxSpec(
      { count: 1, revision: 'c'.repeat(64), mount: 'read-only', storage: { size: '1Gi' } },
      config,
    );
    await putWorkload(deps, r, spec);
    kube.runPods(wl);
    // A fresh process: nothing held. Polling before the first pass does nothing.
    const settle = seedSettler(deps);
    kube.calls = [];
    await settle.poll();
    expect(kube.calls).toEqual([]);
    // The startup pass finds the annotated StatefulSet; pod 0 is still extracting.
    await settle.run();
    expect(kube.calls).toContain(`get pods ${wl}-0`);
    // So the poll keeps checking, with nothing held, and settles it once pod 0 is Initialized.
    kube.objects.pods.get(`${wl}-0`)!.status = {
      conditions: [{ type: 'Initialized', status: 'True' }],
    };
    await settle.poll();
    const sts = kube.objects.statefulsets.get(wl)!;
    expect(sts.spec.template.metadata.annotations['moca.dev/seed-revision']).toBeNull();
    // Nothing left to seed: the poll stops calling the API.
    kube.calls = [];
    await settle.poll();
    expect(kube.calls).toEqual([]);
  });
});
