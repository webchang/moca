import type { TemplateBuild, TemplateDoc } from './template-catalog.js';

/**
 * Activation (template lifecycle spec §6.2-§6.4), as pure functions over the catalog, the hosts'
 * inventories and the relay's presence, so the rules are testable without a host:
 *
 *   - a build is WANTED active while any subject holds an unexpired lease on it (§6.3); aging is
 *     a lease running out, never a deactivation behind a holder's back;
 *   - it is PLACED on a host that holds its snapshot (by manifest hash, §6.1), within that host's
 *     activeLimit: the holding host with the fewest wanted builds, then by id;
 *   - over a host's limit, the newest leases wait: a held build is never evicted to make room,
 *     and the activation that cannot be placed is refused with no_active_slot (§6.3, O11);
 *   - a subject holds at most quota.active builds at once.
 */

export interface HostView {
  id: string;
  /** manifest hash -> template id */
  holds: Record<string, string>;
  activeLimit: number;
}

export interface Placement {
  /** buildId -> host id, for every wanted build that fits. */
  placed: Map<string, string>;
  /** Wanted builds that fit nowhere: no host holds them, or every holder is full. */
  unplaced: Map<string, 'not_held' | 'no_slot'>;
}

export const liveLeases = (b: TemplateBuild, nowS: number) =>
  (b.leases ?? []).filter((l) => l.until > nowS);

/** The wanted builds, their leases' earliest start breaking ties: first leased, first placed. */
export function wantedBuilds(
  docs: TemplateDoc[],
  nowS: number,
): { doc: TemplateDoc; build: TemplateBuild; since: number }[] {
  const out: { doc: TemplateDoc; build: TemplateBuild; since: number }[] = [];
  for (const doc of docs) {
    for (const build of doc.builds) {
      if (build.status !== 'registered') continue;
      const live = liveLeases(build, nowS);
      if (live.length === 0) continue;
      out.push({ doc, build, since: Math.min(...live.map((l) => l.since ?? l.until)) });
    }
  }
  return out.sort((a, b) => a.since - b.since || (a.build.buildId < b.build.buildId ? -1 : 1));
}

export function place(docs: TemplateDoc[], hosts: HostView[], nowS: number): Placement {
  const placed = new Map<string, string>();
  const unplaced = new Map<string, 'not_held' | 'no_slot'>();
  const used = new Map(hosts.map((h) => [h.id, 0]));
  for (const { build } of wantedBuilds(docs, nowS)) {
    const holders = hosts.filter((h) => h.holds[build.buildId] !== undefined);
    if (holders.length === 0) {
      unplaced.set(build.buildId, 'not_held');
      continue;
    }
    const free = holders
      .filter((h) => used.get(h.id)! < h.activeLimit)
      .sort((a, b) => used.get(a.id)! - used.get(b.id)! || (a.id < b.id ? -1 : 1));
    if (free.length === 0) {
      unplaced.set(build.buildId, 'no_slot');
      continue;
    }
    placed.set(build.buildId, free[0]!.id);
    used.set(free[0]!.id, used.get(free[0]!.id)! + 1);
  }
  return { placed, unplaced };
}

/** Readiness of a registered build (§3.3), from what is wanted, placed and attached. */
export function readinessOf(
  build: TemplateBuild,
  nowS: number,
  p: Placement | null,
  attached: Map<string, number> | null,
): 'active' | 'activating' | 'deactivating' | 'inactive' | 'unavailable' | 'unknown' {
  if (attached === null) return 'unknown';
  const isAttached = build.worker !== '' && attached.has(build.worker);
  const wanted = liveLeases(build, nowS).length > 0;
  if (!p) return isAttached ? 'active' : 'inactive';
  if (wanted) {
    if (p.unplaced.has(build.buildId)) return isAttached ? 'active' : 'unavailable';
    return isAttached ? 'active' : 'activating';
  }
  return isAttached ? 'deactivating' : 'inactive';
}
