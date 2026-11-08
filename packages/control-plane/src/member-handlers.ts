import { CpError } from './errors.js';
import { asRecord, isAdmin, requireEnrolledPrincipal, seconds } from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import { GITHUB_SUBJECT_RE } from './identity.js';
import { ADMIN, type MembersStore } from './members.js';
import type { TokenClaims } from './token.js';

/**
 * Enrollment and roles through the API (enrollment and roles spec §4, register G38): admins only.
 * The deployment's settings stay the bootstrap and are never edited here: a subject on
 * SH_ALLOWED_SUBJECTS cannot be unenrolled, and one on SH_ADMIN_SUBJECTS cannot lose the role
 * (`409 bootstrap_subject`), so the deployment can always recover. Any admin, bootstrap or
 * API-granted, may grant admin (§6, decision 1); a grant may carry an expiry (decision 4).
 */

function admin(ctx: RequestCtx, deps: CpDeps): { p: TokenClaims; members: MembersStore } {
  const p = requireEnrolledPrincipal(ctx, deps.config);
  if (!isAdmin(p)) throw new CpError('forbidden', 'managing subjects requires the admin role');
  if (!deps.members)
    throw new CpError(
      'invalid_request',
      'this deployment does not store members (SH_PROVENANCE_DIR is unset): enrollment and roles are its settings',
    );
  return { p, members: deps.members };
}

function subjectParam(ctx: RequestCtx): string {
  const s = ctx.params.subject ?? '';
  if (!GITHUB_SUBJECT_RE.test(s))
    throw new CpError('invalid_request', 'subject must be github:<numeric id>');
  return s;
}

const blank = (subject: string, by: string, nowS: number) => ({
  subject,
  enrolled: false,
  roles: [],
  since: nowS,
  by,
});

export const MEMBER_HANDLERS: Record<string, Handler> = {
  listSubjects: async (ctx, deps) => {
    const { members } = admin(ctx, deps);
    return { status: 200, body: { subjects: await members.list(seconds(deps)) } };
  },

  enrollSubject: async (ctx, deps) => {
    const { p, members } = admin(ctx, deps);
    const subject = subjectParam(ctx);
    if (asRecord(ctx.body).enrolled !== true)
      throw new CpError('invalid_request', 'the body is {"enrolled": true}');
    const nowS = seconds(deps);
    const record = await members.change((doc) => {
      const m = (doc.members[subject] ??= blank(subject, p.sub, nowS));
      if (m.enrolled) return null;
      m.enrolled = true;
      m.since = nowS;
      m.by = p.sub;
      return { kind: 'member', subject: p.sub, body: { subject, enrolled: true, before: false } };
    });
    return {
      status: 200,
      body: { ...(await members.view(subject, seconds(deps))), record },
    };
  },

  unenrollSubject: async (ctx, deps) => {
    const { p, members } = admin(ctx, deps);
    const subject = subjectParam(ctx);
    if (members.bootstrap.allowed.includes(subject) || members.bootstrap.admins.includes(subject))
      throw new CpError(
        'bootstrap_subject',
        `${subject} is enrolled by the deployment's settings (SH_ALLOWED_SUBJECTS or SH_ADMIN_SUBJECTS); remove it there`,
      );
    const nowS = seconds(deps);
    const record = await members.change((doc) => {
      const m = doc.members[subject];
      if (!m?.enrolled) return null;
      m.enrolled = false;
      m.since = nowS;
      m.by = p.sub;
      return { kind: 'member', subject: p.sub, body: { subject, enrolled: false, before: true } };
    });
    return {
      status: 200,
      body: { ...(await members.view(subject, seconds(deps))), record },
    };
  },

  grantAdmin: async (ctx, deps) => {
    const { p, members } = admin(ctx, deps);
    const subject = subjectParam(ctx);
    const raw = asRecord(ctx.body).until;
    const nowS = seconds(deps);
    if (raw !== undefined && raw !== null && !(Number.isSafeInteger(raw) && (raw as number) > nowS))
      throw new CpError(
        'invalid_request',
        'until must be a whole number of epoch seconds in the future (or absent: no expiry)',
      );
    const until = typeof raw === 'number' ? raw : undefined;
    if (members.bootstrap.admins.includes(subject))
      throw new CpError(
        'bootstrap_subject',
        `${subject} is an admin by the deployment's settings (SH_ADMIN_SUBJECTS)`,
      );
    const record = await members.change((doc) => {
      const m = (doc.members[subject] ??= blank(subject, p.sub, nowS));
      const g = m.roles.find((r) => r.role === ADMIN);
      const live = g && (g.until === undefined || g.until > nowS);
      if (live && g.until === until) return null;
      m.roles = m.roles.filter((r) => r.role !== ADMIN);
      m.roles.push({
        role: ADMIN,
        ...(until !== undefined ? { until } : {}),
        by: p.sub,
        since: nowS,
      });
      m.since = nowS;
      m.by = p.sub;
      return {
        kind: 'role',
        subject: p.sub,
        body: {
          subject,
          role: ADMIN,
          state: 'granted',
          until: until ?? null,
          before: live ? 'granted' : 'none',
        },
      };
    });
    return {
      status: 200,
      body: { ...(await members.view(subject, seconds(deps))), record },
    };
  },

  revokeAdmin: async (ctx, deps) => {
    const { p, members } = admin(ctx, deps);
    const subject = subjectParam(ctx);
    if (members.bootstrap.admins.includes(subject))
      throw new CpError(
        'bootstrap_subject',
        `${subject} is an admin by the deployment's settings (SH_ADMIN_SUBJECTS); remove it there`,
      );
    // An admin cannot take its own role: the last API admin could otherwise lock the API out. A
    // bootstrap admin, or another API admin, revokes it.
    if (subject === p.sub)
      throw new CpError('self_revoke', 'an admin cannot revoke its own admin role');
    const nowS = seconds(deps);
    const record = await members.change((doc) => {
      const m = doc.members[subject];
      const g = m?.roles.find((r) => r.role === ADMIN);
      if (!m || !g) return null;
      const live = g.until === undefined || g.until > nowS;
      m.roles = m.roles.filter((r) => r.role !== ADMIN);
      m.since = nowS;
      m.by = p.sub;
      return {
        kind: 'role',
        subject: p.sub,
        body: { subject, role: ADMIN, state: 'revoked', before: live ? 'granted' : 'expired' },
      };
    });
    return {
      status: 200,
      body: { ...(await members.view(subject, seconds(deps))), record },
    };
  },
};
