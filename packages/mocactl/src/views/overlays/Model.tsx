import { Text } from 'ink';
import { useEffect, useState } from 'react';
import type { ModelList } from '../../api/types.js';
import {
  describeError,
  isModelSwitchUnsupported,
  MODEL_SWITCH_UNSUPPORTED,
} from '../../core/messages.js';
import { sanitizeRemote } from '../../core/sanitize.js';
import { formatWindow } from '../../core/session-options.js';
import { SelectList } from '../SelectList.js';
import { Spinner } from '../Spinner.js';

interface Props {
  load: () => Promise<ModelList>;
  /** The session's model; null on the deployment default. */
  current: string | null;
  onSelect: (id: string | null) => void;
  onCancel: () => void;
  /** True when the error was handled (a login opened); the overlay then shows nothing of it. */
  onError: (err: unknown) => boolean;
  /** Reports the screens with no input (loading, an error), so the App's Esc closes them. */
  onInputless?: (inputless: boolean) => void;
}

/** `/model` (per-session model spec §6): the session credential's models, the current one marked. */
export function ModelOverlay({ load, current, onSelect, onCancel, onError, onInputless }: Props) {
  const [list, setList] = useState<ModelList>();
  const [failed, setFailed] = useState<string>();
  /** The control plane predates the catalog (spec §7): /model <id> would 404 too, so no hint. */
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    let live = true;
    load().then(
      (l) => live && setList(l),
      (err: unknown) => {
        if (!live) return;
        if (isModelSwitchUnsupported(err)) {
          setUnsupported(true);
          setFailed(MODEL_SWITCH_UNSUPPORTED);
        } else if (!onError(err)) setFailed(describeError(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const inputless = !!failed || !list;
  useEffect(() => {
    onInputless?.(inputless);
  }, [inputless]);

  if (failed && unsupported) return <Text>{failed} (Esc to close)</Text>;
  if (failed) {
    return (
      <Text>
        {sanitizeRemote(failed)} — switch by name with /model {'<id>'} (Esc to close)
      </Text>
    );
  }
  if (!list) return <Spinner label="loading models…" />;
  const mark = (id: string | null) => (id === current ? 'current' : undefined);
  // A current model the catalog no longer lists (retired, or the key's access narrowed) still gets
  // its row, marked and under the cursor: otherwise one Enter would reset it to the default (F6).
  const unlisted =
    current !== null && !list.models.some((m) => m.id === current)
      ? [
          {
            key: current,
            label: `${sanitizeRemote(current)} (not listed)`,
            detail: 'current',
            value: current,
          },
        ]
      : [];
  return (
    <SelectList<string | null>
      title={`Model — ${sanitizeRemote(list.credential)}`}
      filter="always"
      initialKey={current ?? '__default__'}
      items={[
        { key: '__default__', label: 'deployment default', detail: mark(null), value: null },
        ...unlisted,
        ...list.models.map((m) => ({
          key: m.id,
          label: sanitizeRemote(m.id),
          detail: [formatWindow(m.contextWindow) ?? '', mark(m.id)].filter(Boolean).join('  '),
          value: m.id,
        })),
      ]}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}
