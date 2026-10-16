import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, type CommandHost } from '../src/commands/builtin.js';
import { CommandRegistry } from '../src/commands/registry.js';

function host(hasSession = true): CommandHost & Record<string, ReturnType<typeof vi.fn>> {
  const h = {
    hasSession: vi.fn(() => hasSession),
    openOverlay: vi.fn(),
    newSession: vi.fn(),
    renameSession: vi.fn(),
    switchModel: vi.fn(),
    prefillInput: vi.fn(),
    toggleDetails: vi.fn(),
    toggleThinking: vi.fn(),
    copyLastReply: vi.fn(),
    exportTranscript: vi.fn(),
    composeInEditor: vi.fn(),
    cycleTheme: vi.fn(),
    notify: vi.fn(),
    quit: vi.fn(),
    promoteBundle: vi.fn(),
  };
  return h as never;
}

const registry = new CommandRegistry(BUILTIN_COMMANDS);

describe('BUILTIN_COMMANDS', () => {
  it('has no keybind conflicts', () => {
    expect(registry.conflicts).toEqual([]);
  });

  // The command table of spec §5.2.
  it.each([
    ['/sessions', 'ctrl+x l'],
    ['/resume', 'ctrl+x l'],
    ['/new', 'ctrl+x n'],
    ['/rename', 'ctrl+x r'],
    ['/model', 'ctrl+x m'],
    ['/credentials', 'ctrl+x k'],
    ['/details', 'ctrl+x d'],
    ['/thinking', 'ctrl+x t'],
    ['/copy', 'ctrl+x y'],
    ['/export', 'ctrl+x x'],
    ['/editor', 'ctrl+x e'],
    ['/theme', undefined],
    ['/doctor', undefined],
    ['/help', undefined],
    ['/quit', 'ctrl+x q'],
  ])('%s is bound to %s', (slash, keybind) => {
    const hit = registry.bySlash(slash);
    expect(hit, slash).toBeDefined();
    expect(registry.keybindOf(hit!.command.id)).toBe(keybind);
  });

  it('opens the palette on ctrl+p', () => {
    const h = host();
    registry.byKeybind('ctrl+p')!.run(h, '');
    expect(h.openOverlay).toHaveBeenCalledWith('palette');
  });

  it.each([
    ['/sessions', 'openOverlay', 'sessions'],
    ['/credentials', 'openOverlay', 'credentials'],
    ['/doctor', 'openOverlay', 'doctor'],
    ['/help', 'openOverlay', 'help'],
    ['/new', 'newSession', undefined],
    ['/details', 'toggleDetails', undefined],
    ['/thinking', 'toggleThinking', undefined],
    ['/copy', 'copyLastReply', undefined],
    ['/export', 'exportTranscript', undefined],
    ['/editor', 'composeInEditor', undefined],
    ['/theme', 'cycleTheme', undefined],
    ['/quit', 'quit', undefined],
  ])('%s calls host.%s', async (slash, method, arg) => {
    const h = host();
    const { command, arg: a } = registry.bySlash(slash)!;
    await command.run(h, a);
    if (arg === undefined) expect(h[method]).toHaveBeenCalled();
    else expect(h[method]).toHaveBeenCalledWith(arg);
  });

  it('/rename with a title renames; without one it prefills the input', () => {
    const h = host();
    const hit = registry.bySlash('/rename Payment bug')!;
    hit.command.run(h, hit.arg);
    expect(h.renameSession).toHaveBeenCalledWith('Payment bug');
    registry.byKeybind('ctrl+x r')!.run(h, '');
    expect(h.prefillInput).toHaveBeenCalledWith('/rename ');
  });

  it('/promote is available without a session and hands its argument to the host', async () => {
    const h = host(false);
    const hit = registry.bySlash('/promote ~/skills')!;
    expect(hit.command.when?.(h)).not.toBe(false);
    await hit.command.run(h, hit.arg);
    expect(h.promoteBundle).toHaveBeenCalledWith('~/skills');
  });

  it('/promote without a directory prefills the input', async () => {
    const h = host(false);
    const hit = registry.bySlash('/promote')!;
    await hit.command.run(h, hit.arg);
    expect(h.prefillInput).toHaveBeenCalledWith('/promote ');
    expect(h.promoteBundle).not.toHaveBeenCalled();
  });

  it('hides session-only commands when there is no session', () => {
    const ids = registry.available(host(false)).map((c) => c.id);
    expect(ids).not.toContain('session.rename');
    expect(ids).not.toContain('reply.copy');
    expect(ids).not.toContain('transcript.export');
    expect(ids).toContain('session.new');
  });

  it('/model with an id switches; without one it opens the model list', async () => {
    const h = host();
    const hit = registry.bySlash('/model meta-llama/Llama-3.1-8B-Instruct')!;
    await hit.command.run(h, hit.arg);
    expect(h.switchModel).toHaveBeenCalledWith('meta-llama/Llama-3.1-8B-Instruct');
    const bare = registry.bySlash('/model')!;
    await bare.command.run(h, bare.arg);
    expect(h.openOverlay).toHaveBeenCalledWith('model');
  });

  // PR #540 review R5: only the slash command maps the word `default`; the host takes string | null.
  it('/model default asks for the deployment default as null', async () => {
    const h = host();
    const hit = registry.bySlash('/model default')!;
    await hit.command.run(h, hit.arg);
    expect(h.switchModel).toHaveBeenCalledWith(null);
  });

  it('/model needs an open session', () => {
    expect(registry.available(host(false)).map((c) => c.id)).not.toContain('session.model');
  });
});
