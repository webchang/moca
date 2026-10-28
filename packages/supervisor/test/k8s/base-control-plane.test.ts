import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, container, envVar, find, podSpec, render } from './render.js';

describe.skipIf(NO_KUBECTL)('deploy/k8s base: control plane', () => {
  const dep = () => find(render('base'), 'Deployment', 'moca-control-plane', 'moca');
  const cp = () => container(dep(), 'control-plane');

  it('uses the Kubernetes credential store in its own namespace, explicitly', () => {
    expect(envVar(cp(), 'SH_CREDENTIAL_STORE')?.value).toBe('kubernetes');
    expect(envVar(cp(), 'SH_CREDENTIAL_NAMESPACE')?.value).toBe('moca-credentials');
  });

  it('reads the P6.3 sandbox tier settings from moca-settings (optional)', () => {
    expect(envVar(cp(), 'SH_SANDBOX_TIERS')).toEqual({
      name: 'SH_SANDBOX_TIERS',
      valueFrom: {
        configMapKeyRef: { name: 'moca-settings', key: 'SH_SANDBOX_TIERS', optional: true },
      },
    });
    expect(envVar(cp(), 'SH_SANDBOX_DEFAULT_TIER')).toEqual({
      name: 'SH_SANDBOX_DEFAULT_TIER',
      valueFrom: {
        configMapKeyRef: { name: 'moca-settings', key: 'SH_SANDBOX_DEFAULT_TIER', optional: true },
      },
    });
  });

  it('may touch Secrets in moca-credentials, without list, and nothing about pods', () => {
    const role = find(render('base'), 'Role', 'moca-control-plane-credentials', 'moca-credentials');
    expect(role.rules).toEqual([
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get', 'create', 'update', 'patch', 'delete'],
      },
    ]);
    const rb = find(
      render('base'),
      'RoleBinding',
      'moca-control-plane-credentials',
      'moca-credentials',
    );
    expect(rb.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'moca-control-plane', namespace: 'moca' },
    ]);
    // The pod-exec path's sh-control-plane-pods Role is not needed: a relay-attached harness never
    // reports sandboxPod/sandboxSelector, and its absence fails soft (resources.ts).
    const podRules = render('base')
      .filter((o) => o.kind === 'Role' || o.kind === 'ClusterRole')
      .flatMap((o) => o.rules ?? [])
      .filter((r: { resources: string[] }) => r.resources.includes('pods'));
    expect(podRules).toEqual([]);
  });

  it('mounts its secrets as files from a projected volume, and reads settings from the ConfigMap', () => {
    for (const k of [
      'SH_SESSION_TOKEN_PRIVATE_KEY',
      'SH_CREDENTIAL_KEK',
      'SH_EXCHANGE_TOKEN',
      // ADR-0045: a password on a login path, so it is a FILE like the others -- never an env
      // line, which every kubectl child would inherit.
      'SH_TEST_USER_SECRET',
    ]) {
      expect(envVar(cp(), k)).toBeUndefined();
    }
    expect(envVar(cp(), 'CREDENTIALS_DIRECTORY')?.value).toBe('/run/credentials');
    // A PROJECTED volume (ADR-0045), so the test-user secret can come from a source of its own
    // marked `optional`: the credential loader errors on an empty file and treats only an absent
    // one as "unset", so an empty required key in moca-mu1 crash-loops the control plane.
    const vol = podSpec(dep()).volumes.find((v: { name: string }) => v.name === 'credentials');
    expect(vol.secret).toBeUndefined();
    const sources = vol.projected.sources as Array<{
      secret: { name: string; optional?: boolean; items: Array<{ key: string }> };
    }>;
    const mu1 = sources.find((x) => x.secret.name === 'moca-mu1')!;
    expect(mu1.secret.optional).toBeUndefined(); // required: the stack cannot run without these
    expect(mu1.secret.items.map((i) => i.key).sort()).toEqual([
      'SH_CREDENTIAL_KEK',
      'SH_EXCHANGE_TOKEN',
      'SH_SESSION_TOKEN_PRIVATE_KEY',
    ]);
    const tu = sources.find((x) => x.secret.name === 'moca-test-users')!;
    // Optional, so a stack with test users off -- where setup.sh deletes this Secret -- still boots.
    expect(tu.secret.optional).toBe(true);
    expect(tu.secret.items.map((i) => i.key)).toEqual(['SH_TEST_USER_SECRET']);
    for (const k of [
      'SH_GITHUB_CLIENT_ID',
      'SH_ADMIN_SUBJECTS',
      'SH_PUBLIC_HARNESS_URL',
      'SH_ALLOW_OPERATOR_FALLBACK',
      'SH_API_TOKEN_TTL_SECONDS',
      'SH_SESSION_TOKEN_TTL_SECONDS',
    ]) {
      expect(envVar(cp(), k)).toEqual({
        name: k,
        valueFrom: { configMapKeyRef: { name: 'moca-settings', key: k } },
      });
    }
    // ADR-0045: the test-user count is OPTIONAL, like the tier keys. A moca-settings written by an
    // older setup.sh has no SH_TEST_USERS, and a required ref would stop the control plane from
    // starting at all on an upgraded stack; absent reads as 0 (off).
    expect(envVar(cp(), 'SH_TEST_USERS')).toEqual({
      name: 'SH_TEST_USERS',
      valueFrom: {
        configMapKeyRef: { name: 'moca-settings', key: 'SH_TEST_USERS', optional: true },
      },
    });
  });

  it('keeps the existing probes and needs its ServiceAccount token for the kube API', () => {
    expect(cp().readinessProbe.httpGet).toEqual({ path: '/readyz', port: 'http' });
    expect(cp().livenessProbe.httpGet).toEqual({ path: '/healthz', port: 'http' });
    expect(podSpec(dep()).automountServiceAccountToken).toBe(true);
  });

  it('admits the supervisor, and egresses to Redis and the kube API / GitHub only', () => {
    const p = find(render('base'), 'NetworkPolicy', 'moca-control-plane', 'moca');
    expect(p.spec.ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: { app: 'moca-supervisor' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ]);
    expect(p.spec.egress).toEqual([
      {
        to: [{ podSelector: { matchLabels: { app: 'redis' } } }],
        ports: [{ protocol: 'TCP', port: 6379 }],
      },
      {
        to: [{ ipBlock: { cidr: '0.0.0.0/0' } }],
        ports: [
          { protocol: 'TCP', port: 443 },
          { protocol: 'TCP', port: 6443 },
        ],
      },
    ]);
  });
});
