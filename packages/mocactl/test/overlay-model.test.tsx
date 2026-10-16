import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { ModelOverlay } from '../src/views/overlays/Model.js';
import { KEY, inputReady, waitFor, withTheme } from './helpers/ink.js';

const list = async () => ({
  credential: 'litellm-prod',
  models: [{ id: 'claude-opus-4-8', contextWindow: 200000 }, { id: 'granite-4.1-8b' }],
});

describe('ModelOverlay', () => {
  it('lists the deployment default and the models, marking the current one', async () => {
    const { lastFrame, stdin } = render(
      withTheme(
        <ModelOverlay
          load={list}
          current="granite-4.1-8b"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onError={() => false}
        />,
      ),
    );
    await waitFor(
      () => (lastFrame() ?? '').includes('granite') && inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('deployment default');
    expect(lastFrame()).toContain('claude-opus-4-8');
    expect(lastFrame()).toMatch(/granite-4\.1-8b.*current/);
  });

  // PR #540 review R6: the same window label as New Session's -- not "0k ctx" under 500.
  it('labels a window the way New Session does', async () => {
    const { lastFrame, stdin } = render(
      withTheme(
        <ModelOverlay
          load={async () => ({
            credential: 'c',
            models: [
              { id: 'tiny', contextWindow: 400 },
              { id: 'big', contextWindow: 131072 },
            ],
          })}
          current={null}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onError={() => false}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('big') && inputReady(stdin), 1000, lastFrame);
    expect(lastFrame()).toMatch(/tiny\s+400 ctx/);
    expect(lastFrame()).toMatch(/big\s+131k ctx/);
    expect(lastFrame()).not.toContain('0k ctx');
  });

  it('selects a model on enter, and null for the default', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      withTheme(
        <ModelOverlay
          load={list}
          current={null}
          onSelect={onSelect}
          onCancel={vi.fn()}
          onError={() => false}
        />,
      ),
    );
    await waitFor(
      () => (lastFrame() ?? '').includes('granite') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write(KEY.enter);
    await waitFor(() => onSelect.mock.calls.length > 0, 1000, lastFrame);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('shows why when the catalog cannot be read', async () => {
    const { lastFrame } = render(
      withTheme(
        <ModelOverlay
          load={async () => {
            throw new Error('the inference endpoint could not list models');
          }}
          current={null}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onError={() => false}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('could not list'), 1000, lastFrame);
    expect(lastFrame()).toContain('/model <id>');
  });

  it('says an older control plane cannot switch, on a 404 not_found (final review F4)', async () => {
    const { lastFrame } = render(
      withTheme(
        <ModelOverlay
          load={async () => {
            throw new ApiError('control-plane', 404, 'not_found');
          }}
          current={null}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onError={() => false}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('does not support'), 1000, lastFrame);
    expect(lastFrame()).toContain('this control plane does not support switching models');
    expect(lastFrame()).not.toContain('/model <id>');
  });

  it('keeps a gone session as such, not as an older control plane', async () => {
    const { lastFrame } = render(
      withTheme(
        <ModelOverlay
          load={async () => {
            throw new ApiError('control-plane', 404, 'session_not_found');
          }}
          current={null}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          onError={() => false}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('no longer exists'), 1000, lastFrame);
    expect(lastFrame()).not.toContain('does not support');
  });

  it('marks a current model the catalog does not list, and lands on it (final review F6)', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      withTheme(
        <ModelOverlay
          load={list}
          current="retired-model-1"
          onSelect={onSelect}
          onCancel={vi.fn()}
          onError={() => false}
        />,
      ),
    );
    await waitFor(
      () => (lastFrame() ?? '').includes('granite') && inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toMatch(/retired-model-1 \(not listed\).*current/);
    // One Enter keeps the current model rather than resetting it to the deployment default.
    stdin.write(KEY.enter);
    await waitFor(() => onSelect.mock.calls.length > 0, 1000, lastFrame);
    expect(onSelect).toHaveBeenCalledWith('retired-model-1');
  });
});
