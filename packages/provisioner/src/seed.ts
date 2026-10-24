/**
 * Seeding a workload's PVC (workload sandboxes spec §5.2, §5.3). The worker hands the provisioner
 * the frozen bundle it downloaded from Context Service's export; the provisioner holds it here, in
 * memory and within MOCA_PROVISIONER_SEED_BUDGET_BYTES across all workloads (half of it per owner),
 * until pod `<wl>-0`'s init containers have seeded the claim, or for MOCA_PROVISIONER_SEED_HOLD_S at
 * most. They fetch it from the seed port with the workload's attach token, whose `wl` and `gen` pick
 * the bundle. A provisioner restart before the seed loses it, as does the hold running out: the seed
 * port answers 404 seed_bundle_missing, the GET reports it, and the worker's next activate sends it
 * again.
 */

export interface HeldBundle {
  /** The generation it was handed over for: a token of another generation never fetches it. */
  gen: string;
  /** The owner scope it was handed over for: its share of the budget (BundleStore.ownerBudget). */
  own: string;
  bytes: Buffer;
  /** Epoch seconds it was handed over; a later hand-off (the next activate) refreshes it. */
  at: number;
}

/** How long a bundle is held, by default (MOCA_PROVISIONER_SEED_HOLD_S). */
export const DEFAULT_SEED_HOLD_S = 600;

/**
 * Bundles held for seeding, and the bytes reserved for hand-offs still being read. A hand-off
 * reserves its Content-Length before its body is read (reserve), so held bundles, hand-offs in
 * flight and bundles dropped while a seed GET still sends them (serve) together never pass the
 * budget, and one owner's never pass `ownerBudget`, half of it: one owner's
 * stuck workloads cannot starve every other owner. Every bundle is dropped `holdS` after its last
 * hand-off, whether or not its seed ran (expire): a seed that never starts (a Pending claim, a
 * crash-looping init container) frees its share, and GET reports `seed: bundle_missing` until the
 * next activate resends it.
 */
export class BundleStore {
  private held = new Map<string, HeldBundle>();
  private bytes = 0;
  private reservedTotal = 0;
  private reservedBy = new Map<string, number>();
  /** Buffers a seed GET is sending, and how many GETs; one dropped meanwhile still counts. */
  private serving = new Map<Buffer, number>();
  private lingering = new Set<Buffer>();
  private lingeringBytes = 0;
  /** Workloads DELETE removed, with when: a late hand-off for one is never held again. */
  private retiredAt = new Map<string, number>();
  /** The most one owner may hold and reserve together: half the budget. */
  readonly ownerBudget: number;

  /** `budget`: MOCA_PROVISIONER_SEED_BUDGET_BYTES; `holdS`: MOCA_PROVISIONER_SEED_HOLD_S. */
  constructor(
    readonly budget: number,
    readonly holdS = DEFAULT_SEED_HOLD_S,
  ) {
    this.ownerBudget = Math.floor(budget / 2);
  }

  private ownerBytes(own: string): number {
    let n = this.reservedBy.get(own) ?? 0;
    for (const b of this.held.values()) if (b.own === own) n += b.bytes.length;
    return n;
  }

  /**
   * Reserve `n` bytes for a hand-off to `wl` before reading it. A bundle already held for `wl` (the
   * same owner's earlier activate) does not count against it: it is dropped here, since the new one
   * replaces it, so the bytes in memory never pass what is held and reserved. False when it does not
   * fit the budget or the owner's share of it; nothing is reserved or dropped then.
   */
  reserve(wl: string, own: string, n: number): boolean {
    const prev = this.held.get(wl);
    const replaced = prev && prev.own === own ? prev.bytes.length : 0;
    if (this.inMemory - replaced + n > this.budget) return false;
    if (this.ownerBytes(own) - replaced + n > this.ownerBudget) return false;
    if (replaced) this.drop(wl);
    this.reservedTotal += n;
    this.reservedBy.set(own, (this.reservedBy.get(own) ?? 0) + n);
    return true;
  }

  /** Give back a reservation, once its bundle is held or its hand-off failed. */
  release(own: string, n: number): void {
    this.reservedTotal -= n;
    const left = (this.reservedBy.get(own) ?? 0) - n;
    if (left > 0) this.reservedBy.set(own, left);
    else this.reservedBy.delete(own);
  }

  /** Hold `bundle` for `wl`, replacing an earlier one. Its bytes were reserved before the read. */
  put(wl: string, bundle: HeldBundle): void {
    this.drop(wl);
    this.bytes += bundle.bytes.length;
    this.held.set(wl, bundle);
  }

  get(wl: string): HeldBundle | undefined {
    return this.held.get(wl);
  }

  drop(wl: string): void {
    const b = this.held.get(wl);
    if (!b) return;
    this.bytes -= b.bytes.length;
    this.held.delete(wl);
    // Still being sent: in memory until the last GET ends, so it stays counted until then.
    if (this.serving.has(b.bytes) && !this.lingering.has(b.bytes)) {
      this.lingering.add(b.bytes);
      this.lingeringBytes += b.bytes.length;
    }
  }

  /** A seed GET starts sending `bytes`; call the returned function once it has ended. */
  serve(bytes: Buffer): () => void {
    this.serving.set(bytes, (this.serving.get(bytes) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.serving.get(bytes) ?? 1) - 1;
      if (left > 0) return void this.serving.set(bytes, left);
      this.serving.delete(bytes);
      if (this.lingering.delete(bytes)) this.lingeringBytes -= bytes.length;
    };
  }

  /** DELETE removed `wl`: drop its bundle, and refuse to hold one for it again (retired). */
  retire(wl: string, now: number): void {
    this.drop(wl);
    this.retiredAt.set(wl, now);
  }

  retired(wl: string): boolean {
    return this.retiredAt.has(wl);
  }

  /**
   * Drop every bundle handed over more than `holdS` ago. A retired workload is forgotten after an
   * hour (or `holdS`, if longer), well past any hand-off a worker still waits on; its key names one
   * generation, so it is never provisioned again. Returns the bundles dropped.
   */
  expire(now: number): number {
    let dropped = 0;
    for (const [wl, b] of this.held) {
      if (now - b.at > this.holdS) {
        this.drop(wl);
        dropped++;
      }
    }
    const forget = Math.max(this.holdS, 3600);
    for (const [wl, at] of this.retiredAt) if (now - at > forget) this.retiredAt.delete(wl);
    return dropped;
  }

  entries(): [string, HeldBundle][] {
    return [...this.held];
  }

  get heldBytes(): number {
    return this.bytes;
  }

  get reservedBytes(): number {
    return this.reservedTotal;
  }

  /** Held, reserved, and dropped but still being sent: never more than `budget`. */
  get inMemory(): number {
    return this.bytes + this.reservedTotal + this.lingeringBytes;
  }
}

/** Where each init container mounts what it seeds (spec §5.3: neither mounts the claim root). */
export const SEED_REVISION_DIR = '/seed/revision';
export const SEED_WORKSPACE_DIR = '/seed/workspace';

/** Both scripts: nothing without the annotation; ORDINAL is the pod's, from its name. */
const PREAMBLE = [
  'set -euo pipefail',
  '[ -n "${SEED_REVISION:-}" ] || { echo "seed: no moca.dev/seed-revision, nothing to do"; exit 0; }',
  `[[ "$SEED_REVISION" =~ ^[a-f0-9]{64}$ ]] || { echo "seed: bad revision" >&2; exit 1; }`,
  'ORDINAL="${POD_NAME##*-}"',
];

/**
 * The first init container. It mounts `subPath: revision` read-write and nothing of
 * `moca-workspace`. Only pod `<wl>-0` writes (spec §5.3), so there is one writer and no lock; every
 * other pod waits until `revision/<rev>` exists, then exits 0. In pod 0: an existing
 * `revision/<rev>` is a finished seed, since it only ever appears by the rename below. Otherwise it
 * refuses anything in `revision/` but its own leftover temp dirs, which it removes; fetches the
 * bundle with the attach token; refuses one over MAX_ENTRIES entries; extracts it into a fresh
 * `mktemp` dir; removes write permission; and renames it into place, so a crash never leaves a
 * half-seeded tree under the revision's name.
 */
export const SEED_REVISION_SCRIPT = [
  ...PREAMBLE,
  `cd ${SEED_REVISION_DIR}`,
  'if [ "$ORDINAL" != 0 ]; then',
  '  until [ -d "$SEED_REVISION" ]; do echo "seed: waiting for pod 0 to seed revision $SEED_REVISION"; sleep 2; done',
  '  exit 0',
  'fi',
  '[ ! -d "$SEED_REVISION" ] || { echo "seed: revision $SEED_REVISION already seeded"; exit 0; }',
  'for e in * .[!.]* ..?*; do',
  '  [ -e "$e" ] || [ -L "$e" ] || continue',
  '  case "$e" in .seed-*) ;; *) echo "seed: refusing: revision/ holds $e" >&2; exit 1 ;; esac',
  'done',
  'chmod -R u+w .seed-* 2>/dev/null || true; rm -rf .seed-*',
  'T="$(mktemp -d .seed-XXXXXX)"',
  'trap \'chmod -R u+w "$T" 2>/dev/null || true; rm -rf "$T" "$T.bundle"\' EXIT',
  // -f: a 404 seed_bundle_missing (a provisioner restart) fails the container until a resend.
  'curl -fsS --max-time 600 -H "authorization: Bearer $(cat "$SANDBOX_TOKEN_FILE")" -o "$T.bundle" "$SEED_URL"',
  'ENTRIES="$(tar -tzf "$T.bundle" | wc -l)"',
  '[ "$ENTRIES" -le "$MAX_ENTRIES" ] || { echo "seed: bundle has $ENTRIES entries, over $MAX_ENTRIES" >&2; exit 1; }',
  'tar -xzf "$T.bundle" --no-same-owner --no-same-permissions -C "$T"',
  'rm -f "$T.bundle"',
  // `X` keeps every directory traversable; files keep their exec bits.
  'chmod -R u+rX,a-w "$T"',
  // Absent, checked above, so this is a rename and never a move into it.
  'mv "$T" "$SEED_REVISION"',
  'trap - EXIT',
  'echo "seed: revision $SEED_REVISION seeded ($ENTRIES entries)"',
].join('\n');

/**
 * The second init container, for a writable mount only. It mounts `subPath: revision/<rev>`
 * read-only and `subPath: moca-workspace` read-write, so a symlink planted in the workspace resolves
 * inside its own mounts, never into `revision/`. Other pods than `<wl>-0` wait until the workspace
 * is seeded (it holds no temp dir and is not empty, unless the revision is), then exit 0 without
 * writing. In pod 0 it refuses to seed when `moca-workspace` holds anything but its own leftover
 * temp dirs: that tree is model code's, so a finished seed (or the workload) already filled it. It
 * copies the revision into a fresh temp dir (`cp -a` copies symlinks, never follows them), makes it
 * writable, renames it to `.moca-seed-ready`, and moves its entries into place. The mount point
 * cannot itself be renamed onto, so a crash during those moves leaves `.moca-seed-ready`, and the
 * next run finishes the moves instead of starting again.
 */
export const SEED_WORKSPACE_SCRIPT = [
  ...PREAMBLE,
  `cd ${SEED_WORKSPACE_DIR}`,
  'if [ "$ORDINAL" != 0 ]; then',
  `  until [ -z "$(find . -mindepth 1 -maxdepth 1 -name '.moca-seed-*' -print -quit)" ] &&`,
  `    { [ -n "$(ls -A .)" ] || [ -z "$(ls -A ${SEED_REVISION_DIR})" ]; }; do`,
  '    echo "seed: waiting for pod 0 to seed moca-workspace"; sleep 2',
  '  done',
  '  exit 0',
  'fi',
  'if [ ! -d .moca-seed-ready ] || [ -L .moca-seed-ready ]; then',
  '  for e in * .[!.]* ..?*; do',
  '    [ -e "$e" ] || [ -L "$e" ] || continue',
  '    case "$e" in .moca-seed-*) ;; *) echo "seed: moca-workspace is not empty, not seeding it"; exit 0 ;; esac',
  '  done',
  '  chmod -R u+w .moca-seed-* 2>/dev/null || true; rm -rf .moca-seed-*',
  '  T="$(mktemp -d .moca-seed-XXXXXX)"',
  `  cp -a ${SEED_REVISION_DIR}/. "$T"/`,
  '  chmod -R u+w "$T"',
  '  mv "$T" .moca-seed-ready',
  'fi',
  "find .moca-seed-ready -mindepth 1 -maxdepth 1 -exec mv {} . ';'",
  'rmdir .moca-seed-ready',
  'echo "seed: moca-workspace seeded from revision $SEED_REVISION"',
].join('\n');
