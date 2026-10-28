import { kindSpec, type CredentialDescriptor } from './credential-store.js';
import { checkEgressBindings, renderBindings } from './egress-binding.js';
import { CpError } from './errors.js';
import type { CpDeps } from './handlers.js';

/** Ready header values for one lookup element, and when they stop being good (epoch seconds). */
export interface ResolvedHeaders {
  headers: { name: string; value: string }[];
  expiresAt: number | null;
}

/**
 * How a credential's header values are produced (spec E11, §4.2 step 4). The lookup contract is
 * resolver-neutral: a later `oauth2-refresh` or `token-exchange` resolver changes neither the wire
 * nor the handler.
 *
 * CONTRACT: never return a value with less than 5 s left (the ttlSeconds floor). Refresh it, or
 * throw, or return null to omit the element (the credential vanished between list and get). Otherwise the floor would let moca-egress send a header for up to 5 s
 * after it expired. Refresh material never leaves the control plane.
 */
export type EgressResolver = (
  owner: string,
  d: CredentialDescriptor,
  deps: CpDeps,
) => Promise<ResolvedHeaders | null>;

/** Phase 1's only resolver: decrypt with deps.credentials.get, then renderBindings; expiresAt null. */
export const staticResolver: EgressResolver = async (owner, d, deps) => {
  const stored = await deps.credentials.get(owner, d.name);
  // Deleted between the list and this read: omit the element rather than fail the lookup.
  if (!stored) return null;
  try {
    // A stored binding must still satisfy the write-time rules; never send a malformed header.
    checkEgressBindings(stored.descriptor.binding, kindSpec(stored.descriptor.kind).secretFields);
  } catch (err) {
    if (err instanceof CpError && err.code === 'invalid_request') {
      throw new CpError('credential_unsafe', 'credential_unsafe: stored binding is not renderable');
    }
    throw err;
  }
  return { headers: renderBindings(stored.descriptor.binding, stored.secret), expiresAt: null };
};

/** Always static in phase 1. */
export function resolverFor(_d: CredentialDescriptor): EgressResolver {
  return staticResolver;
}
