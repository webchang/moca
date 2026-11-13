import { SubjectQueue } from './subject-document.js';
import type { TemplateCatalog } from './template-catalog.js';

/**
 * The deployment-wide activation lock. takeLease checks the subject's active quota
 * and the hosts' activeLimit against EVERY template's leases, then writes one template's lease;
 * the catalog serializes writes per template id only, so two activations of different templates
 * (by one subject, or placed on one host) could each pass the check before either lease was
 * written, and together overshoot. One lease-taking check-and-write at a time, per catalog, closes
 * that: each activation sees every earlier one's lease. It covers the policy read, the catalog
 * read, placement, the `activate` record and the lease write (record first, so no lease is stored
 * without its record), and nothing that calls a host. A path that only DROPS leases (deactivate)
 * does not take it: a drop can only free quota or a slot, so an activation that read the leases
 * before a drop judged against more leases than remain, never fewer. A retire and an admin's
 * reject after the fact do take it: each ends a build's use, and takeLease re-reads the build's
 * status under it, so a lease is never written onto a build retired or rejected after the
 * activation resolved it. The wanted answer
 * takes it for its idle-grace stops' lease re-check (register G43), so no lease is written between
 * the re-check and the answer.
 *
 * It is process-local, which suffices because one control plane process owns the store: the
 * Deployment runs one replica (deploy/k8s/base/control-plane.yaml), and the file catalog's volume is
 * ReadWriteOnce with the Recreate strategy (deploy/k8s/overlays/ocp-sbx/template-store), so no
 * second pod writes it, even during a rollout. A control plane with more than one replica on a
 * shared store would need a store-level lock (or a check-and-set on the whole catalog) instead.
 */
const ACTIVATION_LOCKS = new WeakMap<TemplateCatalog, SubjectQueue>();
export function activationLock(cat: TemplateCatalog): SubjectQueue {
  let q = ACTIVATION_LOCKS.get(cat);
  if (!q) ACTIVATION_LOCKS.set(cat, (q = new SubjectQueue()));
  return q;
}

/**
 * The per-template use lock, keyed by template id: a sandbox create's last status read and its
 * store write (createUnlessEnded) against a retire's or a reject's in-use check and catalog write
 * (retireBuilds), on that template only, so creates on different templates never wait on each
 * other. A retire or reject takes it inside the activation lock, always in that order (activation,
 * then template); a create takes only this one, and holds no other lock while it does, so no cycle.
 * Process-local, as the activation lock is.
 */
const TEMPLATE_USE_LOCKS = new WeakMap<TemplateCatalog, SubjectQueue>();
export function templateUseLock(cat: TemplateCatalog): SubjectQueue {
  let q = TEMPLATE_USE_LOCKS.get(cat);
  if (!q) TEMPLATE_USE_LOCKS.set(cat, (q = new SubjectQueue()));
  return q;
}
