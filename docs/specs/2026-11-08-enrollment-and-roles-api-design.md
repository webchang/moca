# Enrollment and roles through the API

- **Status:** design accepted (the user, 2026-11-08: all four proposals in §6); **implemented** (0b88a829 control plane, 49c98a85 mocactl; decision 1 narrowed: only an admin named in the settings changes access); **deployed** on `moca-sbx-template` 2026-11-08 and `moca-combined` 2026-11-09 (register G38).
- **Date:** 2026-11-08
- **Builds on:** [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) §4.2 (enrollment),
  [template lifecycle](2026-11-03-template-lifecycle-and-provenance-design.md) §5 (D10: authorization
  out of scope there), [combined control plane](2026-11-05-combined-control-plane-design.md) §3.2.

## 1. The problem

Who may use the sandbox service, and who is an admin, are **deployment settings**:

- `SH_ALLOWED_SUBJECTS`, the enrolled subjects (sandbox and combined profiles);
- `SH_ADMIN_SUBJECTS`, the admin role (`rolesFor` in `identity.ts`, read when a token is issued).

Changing either means editing the namespace's settings and re-running `setup.sh`, a cluster write by an
operator. The change reaches a logged-in subject at its next token refresh, and leaves no record on
any provenance chain. Every template-level control is already an API call: owner, visibility, quota,
reject and retire. User management is the one lifecycle activity that is not.

Seen in practice: each time an admin action was needed (loading a policy, handing a declared template
over, register G34), the deployment ran three steps. It added a temporary admin by `setup.sh`, the admin
acted through the API, and it removed the admin by `setup.sh` again: two cluster writes for one API call.

## 2. Goals and non-goals

**Goals:**

- An admin enrolls and unenrolls subjects, and grants and revokes the admin role, through the API, as
  with every other lifecycle activity.
- Every change is a provenance record (who, whom, what, before), verifiable offline.
- A change takes effect at the subject's next request, not only at its next refresh (or, at worst,
  within one API-token lifetime, as today).
- The deployment still decides who is admin first (the bootstrap), and can always recover.

**Non-goals:**

- An identity provider: the subjects stay `github:<id>`, from the existing login.
- Fine-grained permissions beyond the roles below: no per-template roles (§6, decision 2).
- Self-enrollment requests (§6, decision 3).
- Groups or tenants. MU2's tenant partition is separate.

## 3. The model

- **A membership store** in the control plane's template store directory (as `policy.json` is): per
  subject, `{subject, enrolled: bool, roles: ["admin"?], since, by}`.
- **The bootstrap admins** are `SH_ADMIN_SUBJECTS`, as today. They're always admins and can't be
  revoked through the API (the recovery path). API-granted admins are additional.
- **Enrollment** is `SH_ALLOWED_SUBJECTS` ∪ the store's enrolled subjects. The env list stays the
  bootstrap and is never edited by the API. A subject unenrolled through the API but still on the env
  list stays enrolled, and the API answers so. Two places with one meaning is the cost of keeping the
  bootstrap: say it in every answer.
- **Roles are evaluated per request** from the store, plus the bootstrap list, not only at token issue.
  A revoked admin loses the role at its next request. Token claims keep `roles` for display only.
- **An admin grant may carry an expiry** (`until`, epoch seconds). Past it, the role is no longer
  evaluated as held. The store keeps the grant, and the first request that sees it lapsed writes a
  `role` record (`expired`) once, as the janitor's sweep does for an expired sandbox.
- **Only the settings' admins change access.** Enrolling, unenrolling, granting and revoking need an
  admin named in `SH_ADMIN_SUBJECTS`. An API-granted admin holds the role for templates, policy and
  quota, and may read the list, but changes no one's access (`403 forbidden`). Every change is
  recorded, naming who made it.

## 4. The API (reads: any admin; changes: an admin named in the settings; both profiles where templates are)

| Route                                       | Body               | Effect                                                              | Record                          |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------- | ------------------------------- |
| `GET /v1/subjects`                          |                    | every enrolled subject, with roles and `source: env \| api`         |                                 |
| `PUT /v1/subjects/{subject}`                | `{enrolled: true}` | enroll                                                              | `member` (enrolled, before)     |
| `DELETE /v1/subjects/{subject}`             |                    | unenroll (refused for a bootstrap subject: `409 bootstrap_subject`) | `member` (unenrolled, before)   |
| `PUT /v1/subjects/{subject}/roles/admin`    | `{until?}`         | grant admin (a settings admin; `until` optional)                    | `role` (granted, until, before) |
| `DELETE /v1/subjects/{subject}/roles/admin` |                    | revoke admin (refused for a bootstrap admin and for oneself)        | `role` (revoked, before)        |

- **Errors:** 400 for a malformed subject, 403 for a caller who isn't an admin, and 409 for a bootstrap
  subject or for revoking oneself.
- **Records:** on a new stream `members`. Each names the acting subject, and the policy-style chain
  makes the whole history verifiable offline with `verify-provenance.py`.
- **mocactl:** `mocactl sbx admin subjects [enroll|unenroll|grant|revoke] SUBJECT`.

## 5. Effects on what exists

- **Unenrolling a subject:**
  - its live sandboxes run to their expiry (or an admin deletes them);
  - its templates keep their owner (an admin can transfer them, `PUT …/owner`);
  - its logins are refused at the next request (`403 not_enrolled`), as a refresh is today.
- **G34-style handovers** need no `setup.sh`: an admin grants a temporary admin with `until`, which
  acts and then lapses on its own, with no revoke step.
- **The harness profile:** enrollment doesn't gate sessions there today (`isEnrolledForSandbox` is
  always true on `harness`). This design doesn't change that.

## 6. Decisions (the user, 2026-11-08: proposals 2-4 accepted; decision 1 narrowed the same day)

1. **Who may change access:** only an admin named in the settings (`SH_ADMIN_SUBJECTS`) may enroll,
   unenroll, grant or revoke (the user, in sbx-template's and autobench's sessions, 2026-11-08,
   replacing the earlier "any admin"). An API-granted admin can't widen or narrow access, so
   access never goes beyond what the settings' admins choose. They stay the recovery path: they
   can't be revoked through the API, and none can revoke itself.
2. **Per-template roles:** none for now. The owner and the admins cover every case seen so far. A
   `maintainer` role (tags, builds, retire; no ownership transfer) can be added later without changing
   this design.
3. **Self-enrollment requests:** none for now. An admin enrolls a subject directly.
4. **Expiry:** an admin grant may carry an optional `until`. The role then lapses by itself, so a
   temporary admin needs no revoke step, and the record names the expiry.

## 7. Tests and validation (when built)

- **Unit:** enrollment and role evaluation per request, the bootstrap rules, the 409s, and the records
  and their chain.
- **On a deployment:** a G34-style handover with an API-granted admin (with `until`) and no `setup.sh`,
  then the offline verify of the `members` stream.

## 8. As built (0b88a829, 49c98a85)

- **The store:** `members.json` beside `policy.json` (`packages/control-plane/src/members.ts`), read
  through an in-memory copy refreshed when the file's mtime changes.
- **Per request:** the router (`server.ts`) replaces a verified token's `roles` with
  `MembersStore.rolesNow` and sets `enrolled` from the store. The device login, the test-user login,
  the refresh, the egress owner check and the owner transfer use the same evaluation
  (`membershipNow`, `handler-util.ts`). Without a store (no `SH_PROVENANCE_DIR`), the token's claims
  stand, as before.
- **Routes** (`member-handlers.ts`), on both route profiles like the other admin routes. With no
  store they answer `400 invalid_request`.
- **Records:** on stream `members`. `member` is `{subject, enrolled, before}`; `role` is
  `{subject, role, state: granted | revoked | expired, until, before}`. Their `subject` is the acting
  admin, or `control-plane` for an `expired`, which is written once, by the first request that sees
  the lapse.
- **Decided here (the spec left it open):** a grant to a subject not yet enrolled is allowed: the
  admin role enrolls it, as a bootstrap admin is. Re-granting an unexpired grant with the same `until`
  writes nothing; with another `until` it writes a new `granted` record.
