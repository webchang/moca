// ADR-0041 (2026-10-11): the Knative/KEDA deployment path is deprecated. This module is the
// single source of the notice text so the HTTP server, the KEDA drainer and the deploy scripts
// cannot drift apart. The P6 supervisor's workers never import it.
//
// Scope (ADR-0037): what is deprecated is the deployment model — the Knative Service, KEDA
// ScaledJobs, KubectlTransport and pod-exec sandboxes — not Kubernetes as a substrate and not
// containers as a sandbox technology.

/** The canonical deprecation notice. Every signal in the rollout carries this text. */
export const KNATIVE_DEPRECATION_NOTICE =
  'DEPRECATED (ADR-0041, 2026-10-11): the Knative/KEDA deployment path is deprecated and ' +
  'receives security and breakage fixes only. Removal comes no earlier than end of October ' +
  '2026, once the remaining users have migrated. P6 - the process-manager runtime - is the ' +
  'primary way to run MOCA sessions; see docs/migrating-from-knative.md.';

/**
 * True when the process runs under Knative Serving, which injects K_SERVICE, K_CONFIGURATION
 * and K_REVISION into every container it manages. The P6 supervisor forks worker.ts without
 * them, so this is the line between "warn" and "stay silent" — never widen it to anything a
 * P6 deployment also sets.
 */
export function runningUnderKnative(env: NodeJS.ProcessEnv): boolean {
  return (
    env.K_SERVICE !== undefined || env.K_CONFIGURATION !== undefined || env.K_REVISION !== undefined
  );
}

/**
 * Emit the deprecation notice once at startup when running under Knative. `warn` is injectable
 * so tests assert on it without capturing the real console.
 */
export function warnKnativeDeprecation(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void = console.warn,
): string | undefined {
  if (!runningUnderKnative(env)) return undefined;
  warn(KNATIVE_DEPRECATION_NOTICE);
  return KNATIVE_DEPRECATION_NOTICE;
}
