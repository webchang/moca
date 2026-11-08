# Enrollment and roles through the API (DRAFT)

- **Status:** draft for review (register G38). Not implemented.
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
- Fine-grained permissions beyond the roles below. Per-template roles are an open question (§6).
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

## 4. The API (admin only, both profiles where templates are)

| Route                                       | Body               | Effect                                                              | Record                        |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------- | ----------------------------- |
| `GET /v1/subjects`                          |                    | every enrolled subject, with roles and `source: env \| api`         |                               |
| `PUT /v1/subjects/{subject}`                | `{enrolled: true}` | enroll                                                              | `member` (enrolled, before)   |
| `DELETE /v1/subjects/{subject}`             |                    | unenroll (refused for a bootstrap subject: `409 bootstrap_subject`) | `member` (unenrolled, before) |
| `PUT /v1/subjects/{subject}/roles/admin`    |                    | grant admin                                                         | `role` (granted, before)      |
| `DELETE /v1/subjects/{subject}/roles/admin` |                    | revoke admin (refused for a bootstrap admin and for oneself)        | `role` (revoked, before)      |

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
- **G34-style handovers** need no `setup.sh`: an API-granted admin acts, then is revoked.
- **The harness profile:** enrollment doesn't gate sessions there today (`isEnrolledForSandbox` is
  always true on `harness`). This design doesn't change that.

## 6. Open questions (for the user)

1. **Who may grant admin:** any admin (proposed), or only bootstrap admins?
2. **Per-template roles:** is a `maintainer` beside the owner wanted? It could move tags, add builds and
   retire, but not transfer ownership. Proposed: not now; owner plus admin covers what we have seen.
3. **Self-enrollment requests:** should a subject be able to ask to be enrolled (a pending state an
   admin approves)? Proposed: not now.
4. **Expiry:** should an API grant of admin carry an optional expiry (`until`), so a temporary admin
   needs no revoke step? Proposed: yes, `{until}` on the role PUT; the record names it.

## 7. Tests and validation (when built)

- **Unit:** enrollment and role evaluation per request, the bootstrap rules, the 409s, and the records
  and their chain.
- **On a deployment:** a G34-style handover with an API-granted admin (with `until`) and no `setup.sh`,
  then the offline verify of the `members` stream.
