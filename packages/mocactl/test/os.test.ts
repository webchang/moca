import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/config.js';
import {
  editorArgv,
  editorCommand,
  loginHelpers,
  openCommand,
  realOs,
  writeExport,
} from '../src/os.js';

describe('editorCommand', () => {
  it('prefers VISUAL, then EDITOR, then vi', () => {
    expect(editorCommand({ VISUAL: 'code --wait', EDITOR: 'nano' })).toBe('code --wait');
    expect(editorCommand({ EDITOR: 'nano' })).toBe('nano');
    expect(editorCommand({})).toBe('vi');
  });
});

describe('loginHelpers', () => {
  const os = { copy: async () => undefined, openUrl: () => undefined };
  const tty = { stdin: true, stderr: true };

  it('offers the clipboard and browser in a local terminal', () => {
    expect(loginHelpers({}, tty, os, 'darwin')).toBeDefined();
    expect(loginHelpers({}, tty, os, 'win32')).toBeDefined();
    expect(loginHelpers({ DISPLAY: ':0' }, tty, os, 'linux')).toBeDefined();
    expect(loginHelpers({ WAYLAND_DISPLAY: 'wayland-0' }, tty, os, 'linux')).toBeDefined();
  });

  it('offers nothing when stdin or stderr is not a terminal', () => {
    expect(loginHelpers({}, { stdin: false, stderr: true }, os, 'darwin')).toBeUndefined();
    expect(loginHelpers({}, { stdin: true, stderr: false }, os, 'darwin')).toBeUndefined();
  });

  it('offers nothing over SSH', () => {
    expect(loginHelpers({ SSH_CONNECTION: '1 2 3 4' }, tty, os, 'darwin')).toBeUndefined();
    expect(loginHelpers({ SSH_TTY: '/dev/ttys001' }, tty, os, 'darwin')).toBeUndefined();
    expect(loginHelpers({ SSH_CLIENT: '1 2 3' }, tty, os, 'darwin')).toBeUndefined();
  });

  it('offers nothing under sudo, which strips SSH_* and would open the browser as root', () => {
    expect(loginHelpers({ SUDO_USER: 'ed' }, tty, os, 'darwin')).toBeUndefined();
    expect(loginHelpers({ SUDO_USER: 'ed', DISPLAY: ':0' }, tty, os, 'linux')).toBeUndefined();
  });

  it('offers the given copy and openUrl, and is busy only while a copy is unsettled', async () => {
    const opened: string[] = [];
    let release!: () => void;
    const copies: string[] = [];
    const h = loginHelpers(
      {},
      tty,
      {
        copy: (t) => {
          copies.push(t);
          return new Promise<void>((r) => (release = r));
        },
        openUrl: (u) => void opened.push(u),
      },
      'darwin',
    )!;
    expect(h.busy()).toBe(false);
    const p = h.copy('ABCD-1234');
    expect(h.busy()).toBe(true);
    release();
    await p;
    expect(h.busy()).toBe(false);
    expect(copies).toEqual(['ABCD-1234']);
    h.openUrl('https://x/');
    expect(opened).toEqual(['https://x/']);
  });

  it('is not left busy by a copy that fails', async () => {
    const h = loginHelpers(
      {},
      tty,
      {
        copy: async () => {
          throw new Error('no clipboard');
        },
        openUrl: () => undefined,
      },
      'darwin',
    )!;
    await expect(h.copy('ABCD-1234')).rejects.toThrow('no clipboard');
    expect(h.busy()).toBe(false);
  });

  it('offers nothing off macOS and Windows without a display (headless, container, console)', () => {
    expect(loginHelpers({}, tty, os, 'linux')).toBeUndefined();
    expect(loginHelpers({}, tty, os, 'freebsd')).toBeUndefined();
  });
});

describe('openCommand', () => {
  it('uses the platform opener', () => {
    expect(openCommand('darwin', 'https://x')).toEqual({ cmd: 'open', args: ['https://x/'] });
    expect(openCommand('linux', 'https://x')).toEqual({ cmd: 'xdg-open', args: ['https://x/'] });
    expect(openCommand('win32', 'https://x')).toEqual({
      cmd: 'rundll32',
      args: ['url.dll,FileProtocolHandler', 'https://x/'],
    });
  });

  it('never hands a Windows URL to cmd.exe, which would parse & | and %VAR% in it', () => {
    const url = 'https://evil.example/?a&calc.exe|x%PATH%';
    const command = openCommand('win32', url);
    expect(command).toEqual({ cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
    expect(command?.cmd).not.toMatch(/^cmd/i);
    expect(command?.args).not.toContain('/c');
  });
});

describe('openCommand with a server-supplied URL', () => {
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ssh://host',
    '/Applications/Calc.app',
    '',
  ])('opens nothing for %j', (url) => {
    expect(openCommand('darwin', url)).toBeUndefined();
    expect(openCommand('win32', url)).toBeUndefined();
    expect(openCommand('linux', url)).toBeUndefined();
  });

  it('still opens an http URL', () => {
    expect(openCommand('darwin', 'http://cp/login')).toEqual({
      cmd: 'open',
      args: ['http://cp/login'],
    });
  });
});

describe('editText', () => {
  it('returns what the editor saved, without the trailing newline', () => {
    // A fake "editor": a shell command that appends a line to the file it is given.
    const os = realOs({ EDITOR: 'sh -c \'printf "%s\\n" "$(cat "$0") edited" > "$0"\'' });
    expect(os.editText('draft')).toBe('draft edited');
  });

  it('throws instead of silently returning the initial text when the editor cannot be found', () => {
    const os = realOs({ EDITOR: 'definitely-not-an-editor-xyz' });
    expect(() => os.editText('draft')).toThrow(/could not start editor/i);
  });

  it('still removes its temp dir when the editor fails to start', () => {
    const os = realOs({ EDITOR: 'definitely-not-an-editor-xyz' });
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('mocactl-edit-')));
    expect(() => os.editText('draft')).toThrow();
    const leaked = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('mocactl-edit-') && !before.has(n),
    );
    expect(leaked).toEqual([]);
  });

  it('throws when the editor process is killed by a signal', () => {
    // The "editor" is sh itself (runEditor starts no shell of its own), and it signals itself.
    const os = realOs({ EDITOR: "sh -c 'kill -TERM $$'" });
    expect(() => os.editText('draft')).toThrow(/signal/i);
  });
});

describe('editorArgv', () => {
  it('splits on whitespace and honours quotes and backslashes, like a shell would', () => {
    expect(editorArgv('code --wait')).toEqual(['code', '--wait']);
    expect(editorArgv('  vim  ')).toEqual(['vim']);
    expect(editorArgv('"/Applications/Sublime Text.app/bin/subl" -w')).toEqual([
      '/Applications/Sublime Text.app/bin/subl',
      '-w',
    ]);
    expect(editorArgv('sh -c \'echo "$0"\'')).toEqual(['sh', '-c', 'echo "$0"']);
    expect(editorArgv('a\\ b "c\\"d" ""')).toEqual(['a b', 'c"d', '']);
  });

  it('expands nothing: $VAR, backticks, globs and # are literal', () => {
    expect(editorArgv('ed $HOME `id` *.md #x')).toEqual(['ed', '$HOME', '`id`', '*.md', '#x']);
  });

  it('refuses an unterminated quote or a blank command', () => {
    expect(() => editorArgv('"vim')).toThrow(/unterminated/);
    expect(() => editorArgv('   ')).toThrow(/blank/);
  });
});

describe('the editor runs without a shell', () => {
  it('never lets a shell interpret $EDITOR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocactl-os-'));
    const marker = join(dir, 'pwned');
    // Under `sh -c "<editor> …"` this would run touch; without a shell, `true` just gets the words.
    const os = realOs({ EDITOR: `true $(touch ${marker}) ; touch ${marker}` });
    expect(os.editText('draft')).toBe('draft');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('openInEditor', () => {
  it('passes a file path with a space and a literal $HOME as a single, unexpanded argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocactl-os-'));
    const file = join(dir, 'a file $HOME name.md');
    writeFileSync(file, 'original');
    const recordFile = join(dir, 'argv.txt');
    // A fake "editor" that records the exact argument it was invoked with.
    const os = realOs({
      EDITOR: `sh -c 'printf "%s" "$0" > ${JSON.stringify(recordFile)}'`,
    });
    os.openInEditor(file);
    expect(readFileSync(recordFile, 'utf8')).toBe(file);
  });
});

describe('writeExport', () => {
  it('writes a private Markdown file under the exports directory', () => {
    const paths = resolvePaths({}, mkdtempSync(join(tmpdir(), 'mocactl-os-')));
    const file = writeExport(paths, 's1', '# hi\n');
    expect(file).toBe(join(paths.exportsDir, 's1.md'));
    expect(readFileSync(file, 'utf8')).toBe('# hi\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a session id that could escape the exports directory', () => {
    const paths = resolvePaths({}, mkdtempSync(join(tmpdir(), 'mocactl-os-')));
    expect(() => writeExport(paths, '../evil', '# hi\n')).toThrow(/unsafe/i);
    expect(() => writeExport(paths, 'a/b', '# hi\n')).toThrow(/unsafe/i);
  });
});
