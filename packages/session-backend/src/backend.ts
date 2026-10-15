// packages/session-backend/src/backend.ts
import type { StoredEntry } from './entry';

/**
 * Generic append-only log store. Entry-agnostic: stores opaque `E` records keyed
 * by session_id. Shaped to upstream Pi issue #2032, but kept free of any Pi types
 * so this package has no dependency on the fork.
 */
export interface LogStore<E = unknown> {
  /** Append one entry; returns the stored envelope (with assigned position + hash). */
  append(session_id: string, entry: E, piType: string): Promise<StoredEntry<E>>;
  /** Read entries in append order, optionally from a 1-based position offset. */
  read(session_id: string, fromPosition?: number): Promise<StoredEntry<E>[]>;
  /** Most recent entry whose payload satisfies `predicate`, or null. */
  latestWhere(session_id: string, predicate: (entry: E) => boolean): Promise<StoredEntry<E> | null>;
  /** Next position index for a session (1-based; equals current count + 1). */
  nextPosition(session_id: string): Promise<number>;
  /** Position (1-based) of the stored entry whose decoded payload `.id` equals `id`, or null. O(N). */
  positionOfId(session_id: string, id: string): Promise<number | null>;
  // NOTE: no list(). A store keyed by session id has no subject concept, so any listing it could
  // offer is an all-tenant enumeration (rossoctl/moca#361). The scoped path is the control plane's
  // OwnershipIndex.listByOwner, backed by per-owner zsets -- spec §13 of the multi-user isolation
  // design. This interface must not grow a listing back.
}
