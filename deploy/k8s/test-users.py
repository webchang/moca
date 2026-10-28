#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Drive N test users through MOCA, proving the multi-user claims (ADR-0045, #616).

Needs a control plane brought up with SH_TEST_USERS=N and SH_TEST_USER_SECRET, and the same
secret here in MOCA_TEST_USER_SECRET.

Two modes:
  (default) --cli   every step is a real `mocactl` command, so what passes is what a user's
                    client actually does;
  --api             the same claims straight against the HTTP API with urllib, as a reference
                    for a non-CLI client (and a way to tell a CLI bug from a server bug).

WHY A DIRECTORY PER USER: mocactl keeps its login in one auth.json holding exactly one CachedAuth
(packages/mocactl/src/config.ts), resolved from XDG_CONFIG_HOME. One process in one directory
therefore CANNOT hold ten logins -- a second `login` overwrites the first. So each user gets its
own XDG_CONFIG_HOME, which is also what makes --jobs safe.

Stdlib only, so `uv run` needs no PyPI egress from a locked-down network.

Usage:
    export MOCA_TEST_USER_SECRET=...
    ./test-users.py --users 10
    ./test-users.py --users 10 --api --json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

# The message the control plane returns for someone else's session, asserted in
# packages/mocactl/test/messages.test.ts -- if this string changes, that test changes with it.
NOT_YOURS = 'that session no longer exists, or is not yours'


@dataclass
class Claim:
    name: str
    ok: bool
    detail: str = ''


@dataclass
class UserRun:
    index: int
    subject: str = ''
    display_name: str = ''
    session_id: str = ''
    claims: list[Claim] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(c.ok for c in self.claims)

    def add(self, name: str, ok: bool, detail: str = '') -> bool:
        self.claims.append(Claim(name, ok, detail))
        return ok


class Driver:
    """Shared surface so the CLI and API modes run the SAME claim sequence."""

    def login(self, u: UserRun) -> bool: ...
    def doctor(self, u: UserRun) -> bool: ...
    def add_credential(self, u: UserRun) -> bool: ...
    def run_turn(self, u: UserRun, prompt: str) -> tuple[bool, str]: ...
    def list_sessions(self, u: UserRun) -> tuple[bool, list[str]]: ...
    def resume(self, u: UserRun, session_id: str) -> tuple[int, str]: ...


# ---------------------------------------------------------------- CLI mode


class CliDriver(Driver):
    def __init__(self, args: argparse.Namespace, rundir: Path):
        self.mocactl = args.mocactl
        self.cp = args.control_plane_url
        self.secret = args.secret
        self.rundir = rundir
        self.model_endpoint = args.model_endpoint
        self.model_token = args.model_token
        self.model_kind = args.model_kind
        self.timeout = args.timeout

    def _home(self, index: int) -> Path:
        d = self.rundir / f'u{index:03d}'
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _run(
        self, index: int, argv: list[str], stdin: str | None = None
    ) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ)
        # The per-user isolation: see the module docstring.
        env['XDG_CONFIG_HOME'] = str(self._home(index))
        env['XDG_STATE_HOME'] = str(self._home(index) / 'state')
        env['MOCA_TEST_USER_SECRET'] = self.secret
        cmd = [*self.mocactl.split(), '--control-plane-url', self.cp, *argv]
        return subprocess.run(
            cmd,
            input=stdin,
            capture_output=True,
            text=True,
            timeout=self.timeout,
            env=env,
        )

    def login(self, u: UserRun) -> bool:
        p = self._run(u.index, ['login', '--test-user', str(u.index)])
        out = (p.stdout + p.stderr).strip()
        if p.returncode != 0:
            return u.add('login', False, out[:200])
        # mocactl prints "logged in as Test User N (test:N)"
        u.subject = f'test:{u.index}'
        u.display_name = f'Test User {u.index}'
        return u.add('login', u.subject in out, out[:120] or 'no output')

    def doctor(self, u: UserRun) -> bool:
        p = self._run(u.index, ['doctor'])
        out = p.stdout + p.stderr
        # Report the failing lines, not just the count: a red check names its own fix.
        bad = [ln.strip() for ln in out.splitlines() if ln.strip().startswith(('✗', 'x '))]
        return u.add('doctor', p.returncode == 0 and not bad, '; '.join(bad)[:200])

    def add_credential(self, u: UserRun) -> bool:
        if not self.model_token:
            return u.add('credential', True, 'skipped (no --model-token)')
        host = urlsplit(self.model_endpoint).hostname or ''
        p = self._run(
            u.index,
            [
                'credentials', 'add', f'test-user-{u.index}',
                '--host', host,
                '--kind', self.model_kind,
                '--endpoint', self.model_endpoint,
            ],
            # The secret travels on stdin, never argv.
            stdin=self.model_token,
        )
        out = (p.stdout + p.stderr).strip()
        return u.add('credential', p.returncode == 0, out[:160])

    def run_turn(self, u: UserRun, prompt: str) -> tuple[bool, str]:
        p = self._run(u.index, ['run', prompt])
        out = (p.stdout + p.stderr).strip()
        for line in out.splitlines():
            if line.startswith('session '):
                u.session_id = line.split(None, 1)[1].strip()
        return p.returncode == 0, out

    def list_sessions(self, u: UserRun) -> tuple[bool, list[str]]:
        p = self._run(u.index, ['sessions'])
        ids = [
            ln.split()[0]
            for ln in p.stdout.splitlines()[1:]
            if ln.strip() and not ln.startswith('ID')
        ]
        return p.returncode == 0, ids

    def resume(self, u: UserRun, session_id: str) -> tuple[int, str]:
        p = self._run(u.index, ['run', 'reply with OK only', '--session', session_id])
        return p.returncode, (p.stdout + p.stderr).strip()


# ---------------------------------------------------------------- API mode


class ApiDriver(Driver):
    def __init__(self, args: argparse.Namespace):
        self.cp = args.control_plane_url.rstrip('/')
        self.secret = args.secret
        self.timeout = args.timeout
        self.tokens: dict[int, str] = {}
        self.model_endpoint = args.model_endpoint
        self.model_token = args.model_token
        self.model_kind = args.model_kind

    def _call(
        self, method: str, path: str, body: dict | None = None, token: str | None = None
    ) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f'{self.cp}{path}', data=data, method=method)
        req.add_header('Content-Type', 'application/json')
        if token:
            req.add_header('Authorization', f'Bearer {token}')
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw.strip() else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode() if e.fp else ''
            try:
                return e.code, json.loads(raw) if raw.strip() else {}
            except json.JSONDecodeError:
                return e.code, {'raw': raw[:200]}
        except Exception as exc:  # noqa: BLE001 - reported, not raised
            return 0, {'error': f'{type(exc).__name__}: {exc}'}

    def login(self, u: UserRun) -> bool:
        st, body = self._call(
            'POST', '/v1/auth/test-token', {'index': u.index, 'secret': self.secret}
        )
        if st != 200 or 'token' not in body:
            return u.add('login', False, f'{st} {json.dumps(body)[:160]}')
        self.tokens[u.index] = body['token']
        u.subject = body.get('subject', '')
        u.display_name = body.get('displayName', '')
        # A test user must get the same login shape as a device login: a refresh token too.
        return u.add(
            'login',
            u.subject == f'test:{u.index}' and bool(body.get('refreshToken')),
            f"subject={u.subject} refresh={'yes' if body.get('refreshToken') else 'NO'}",
        )

    def doctor(self, u: UserRun) -> bool:
        st, body = self._call('GET', '/v1/me', token=self.tokens.get(u.index))
        return u.add(
            'me', st == 200 and body.get('subject') == u.subject, f'{st} {json.dumps(body)[:120]}'
        )

    def add_credential(self, u: UserRun) -> bool:
        if not self.model_token:
            return u.add('credential', True, 'skipped (no --model-token)')
        host = urlsplit(self.model_endpoint).hostname or ''
        field_name = 'token' if self.model_kind == 'bearer' else 'key'
        st, body = self._call(
            'PUT',
            f'/v1/credentials/test-user-{u.index}',
            {
                'kind': self.model_kind,
                'consumer': 'inference',
                'destination': {'hosts': [host]},
                'endpoint': self.model_endpoint,
                'secret': {field_name: self.model_token},
            },
            token=self.tokens.get(u.index),
        )
        return u.add('credential', 200 <= st < 300, f'{st} {json.dumps(body)[:120]}')

    def run_turn(self, u: UserRun, prompt: str) -> tuple[bool, str]:
        # A turn needs the harness; in API mode we assert the control plane's half only (a session),
        # which is what isolation is actually about.
        st, body = self._call('POST', '/v1/sessions', {}, token=self.tokens.get(u.index))
        if st not in (200, 201):
            return False, f'{st} {json.dumps(body)[:160]}'
        u.session_id = body.get('sessionId', '')
        return bool(u.session_id), f'session {u.session_id}'

    def list_sessions(self, u: UserRun) -> tuple[bool, list[str]]:
        st, body = self._call('GET', '/v1/sessions', token=self.tokens.get(u.index))
        ids = [s.get('sessionId', '') for s in (body.get('sessions') or [])]
        return st == 200, ids

    def resume(self, u: UserRun, session_id: str) -> tuple[int, str]:
        st, body = self._call(
            'GET', f'/v1/sessions/{session_id}', token=self.tokens.get(u.index)
        )
        return (0 if st == 200 else 1), f'{st} {json.dumps(body)[:160]}'


# ---------------------------------------------------------------- the run


def one_user(driver: Driver, index: int, prompt: str) -> UserRun:
    u = UserRun(index=index)
    if not driver.login(u):
        return u
    driver.doctor(u)
    driver.add_credential(u)
    ok, out = driver.run_turn(u, prompt)
    # One simple operation per user, and the reply must show it really ran.
    u.add('turn', ok and bool(u.session_id), (out.splitlines() or [''])[-1][:160])
    return u


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--users', type=int, default=10, help='how many test users (default 10)')
    ap.add_argument('--control-plane-url', default=os.environ.get('SH_CONTROL_PLANE_URL', 'http://127.0.0.1:8090'))
    ap.add_argument('--mocactl', default=os.environ.get('MOCACTL', 'mocactl'))
    ap.add_argument('--api', action='store_true', help='drive the HTTP API instead of mocactl')
    ap.add_argument('--jobs', type=int, default=1, help='users to run concurrently (default 1)')
    ap.add_argument('--prompt', default='Reply with exactly: READY')
    ap.add_argument('--model-endpoint', default=os.environ.get('ANTHROPIC_BASE_URL', ''))
    ap.add_argument('--model-kind', default='bearer', choices=['bearer', 'api-key'])
    ap.add_argument('--timeout', type=float, default=300.0)
    ap.add_argument('--keep', action='store_true', help='keep the per-user config dirs')
    ap.add_argument('--json', dest='as_json', action='store_true')
    args = ap.parse_args(argv)

    # Secrets from the environment only, never a flag.
    args.secret = os.environ.get('MOCA_TEST_USER_SECRET', '')
    args.model_token = os.environ.get('ANTHROPIC_AUTH_TOKEN', '') or os.environ.get('SMOKE_MODEL_TOKEN', '')
    if not args.secret:
        print('MOCA_TEST_USER_SECRET is not set (must match the control plane\'s '
              'SH_TEST_USER_SECRET)', file=sys.stderr)
        return 2
    if args.users < 2:
        print('--users must be at least 2: the cross-user claims need two users', file=sys.stderr)
        return 2

    if not args.api and not shutil.which(args.mocactl.split()[0]):
        print(f'mocactl not found on PATH as {args.mocactl!r}; pass --mocactl or use --api',
              file=sys.stderr)
        return 2

    rundir = Path(tempfile.mkdtemp(prefix='moca-test-users-'))
    driver: Driver = ApiDriver(args) if args.api else CliDriver(args, rundir)

    print(f'moca test users: N={args.users}  mode={"api" if args.api else "cli"}  '
          f'cp={args.control_plane_url}')
    print(f'  config dirs: {rundir}' if not args.api else '  (no config dirs in api mode)')

    try:
        if args.jobs > 1:
            with ThreadPoolExecutor(max_workers=args.jobs) as pool:
                runs = list(pool.map(lambda i: one_user(driver, i, args.prompt),
                                     range(1, args.users + 1)))
        else:
            runs = [one_user(driver, i, args.prompt) for i in range(1, args.users + 1)]

        # ---- cross-user claims, the reason this script exists ----
        cross: list[Claim] = []
        u1, u2 = runs[0], runs[1]
        # Both ids are PREREQUISITES, not a condition to skip on: without them the ownership
        # claims below would pass vacuously ('' is "not in" any list, and a missing id would
        # simply not be tested), which is the opposite of what this script is for.
        if not u1.session_id or not u2.session_id:
            cross.append(Claim(
                'both users have a session to test ownership with',
                False,
                f'user 1 session={u1.session_id or "MISSING"}, '
                f'user 2 session={u2.session_id or "MISSING"}',
            ))
        else:
            rc, out = driver.resume(u2, u1.session_id)
            # User 2 must be refused user 1's REAL session id.
            cross.append(Claim(
                "user 2 refused user 1's session",
                rc != 0 and (NOT_YOURS in out or 'not_found' in out or '404' in out),
                out.splitlines()[-1][:160] if out else '',
            ))
            # ...and user 1 must still be able to resume it, proving the id was real and the
            # refusal was about ownership, not a dead session.
            rc1, out1 = driver.resume(u1, u1.session_id)
            cross.append(Claim("user 1 resumes its own session", rc1 == 0,
                               out1.splitlines()[-1][:160] if out1 else ''))
            # Each user's list holds only their own sessions. Asserted inside this branch so a
            # missing user-2 id cannot make the exclusion trivially true.
            ok_list, ids1 = driver.list_sessions(u1)
            cross.append(Claim("user 1's session list excludes user 2's",
                               ok_list and u1.session_id in ids1 and u2.session_id not in ids1,
                               f'{len(ids1)} session(s)'))
        rc, out = driver.resume(u2, 'sess-does-not-exist')
        cross.append(Claim('a session that never existed is refused the same way',
                           rc != 0 and (NOT_YOURS in out or 'not_found' in out or '404' in out),
                           out.splitlines()[-1][:160] if out else ''))

        # ---- report ----
        print()
        print(f"{'user':<8}{'subject':<12}{'login':<7}{'doctor':<8}{'cred':<7}{'turn':<7}session")
        print('-' * 78)
        for u in runs:
            def mark(n: str) -> str:
                c = next((c for c in u.claims if c.name == n), None)
                return '-' if c is None else ('ok' if c.ok else 'FAIL')
            print(f'{u.index:<8}{u.subject or "-":<12}{mark("login"):<7}'
                  f'{mark("doctor") if not args.api else mark("me"):<8}'
                  f'{mark("credential"):<7}{mark("turn"):<7}{u.session_id[:36]}')
        for u in runs:
            for c in u.claims:
                if not c.ok:
                    print(f'  FAIL user {u.index} {c.name}: {c.detail}')
        print()
        print('cross-user claims:')
        for c in cross:
            print(f'  {"ok  " if c.ok else "FAIL"} {c.name}' + (f' — {c.detail}' if c.detail and not c.ok else ''))

        users_ok = sum(1 for u in runs if u.ok)
        cross_ok = sum(1 for c in cross if c.ok)
        print()
        print(f'users {users_ok}/{len(runs)} fully ok;  cross-user {cross_ok}/{len(cross)}')
        passed = users_ok == len(runs) and cross_ok == len(cross)
        print('RESULT: ' + ('PASS' if passed else 'FAIL'))

        if args.as_json:
            print(json.dumps({
                'users': [
                    {'index': u.index, 'subject': u.subject, 'sessionId': u.session_id,
                     'claims': [{'name': c.name, 'ok': c.ok, 'detail': c.detail} for c in u.claims]}
                    for u in runs
                ],
                'crossUser': [{'name': c.name, 'ok': c.ok, 'detail': c.detail} for c in cross],
                'pass': passed,
            }, indent=2))
        return 0 if passed else 1
    finally:
        # --api creates no per-user config dirs, so its rundir is always an empty leftover: remove
        # it unless --keep was asked for, the same as cli mode.
        if args.keep:
            print(f'kept {rundir}')
        else:
            shutil.rmtree(rundir, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
