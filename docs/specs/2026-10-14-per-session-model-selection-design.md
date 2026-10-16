# Per-session model selection — choose and switch the model behind one inference credential — Design

**Date:** 2026-10-14 · **Status:** Implemented · **Issue:** none yet (owed item 3 of the
[mocactl spec §13](2026-09-25-mocactl-control-plane-client-design.md))
**Builds on (reuse, no redesign):** [multi-user-control-plane-design](2026-09-08-multi-user-control-plane-design.md)
(MU1: the credential store, the exchange, the `SessionRecord`);
[multi-protocol-model-provider-design](2026-08-20-multi-protocol-model-provider-design.md) (`SH_MODEL_*`,
the synthesized custom model, `SH_MODEL_API`); P6.3's sandbox tier (the create → store → exchange →
`TurnConfig` path this spec copies field for field);
[mocactl-control-plane-client-design](2026-09-25-mocactl-control-plane-client-design.md) §7.3 (the
session-options field list); [change policy](../reference/change-policy.md) (everything here is additive).

## 1. Problem

A user holds one inference credential — a key and an endpoint — and that one credential reaches many
models. Where a provider or model is not supported by pi directly, it sits behind LiteLLM, reached
with the same key and endpoint. The user must be able to pick the model when starting a session and
to change it later without touching the credential. Direct Anthropic (`api-key` at
`https://api.anthropic.com`) must keep working as it does today.

Today (`rossoctl/main` @ `a4f95c7`) the model is a deployment-wide setting:

- `resolveModelSelection` (`harness/src/run-turn.ts:350`) takes the model from `TurnConfig.model`,
  then `SH_MODEL`, then `claude-opus-4-8`.
- On the server path nothing sets `TurnConfig.model`: `buildConfig(auth)`
  (`packages/knative-server/src/server.ts:82`) copies only the base URL, the credential and the
  sandbox tier from the exchange. Every session runs `SH_MODEL`.
- `requireModel` (`harness/src/run-turn.ts:513`) looks the id up in pi's registry, or, under
  `SH_MODEL_CUSTOM=1`, synthesizes a model whose context window, output limit and headers come from
  process-wide environment variables (`synthesizeCustomModel`, `run-turn.ts:405`).
- The credential store has no model field; the `SessionRecord` (`packages/control-plane/src/ownership.ts:43`)
  has none either. `POST /v1/sessions` (`handlers.ts:427`) accepts `credentials.inference` and
  `sandbox.tier` only.
- `mocactl` offers two session options, `inferenceCredential` and `sandboxTier`
  (`packages/mocactl/src/core/session-options.ts:98`), and its spec lists per-session model selection
  as out of scope pending this backend work.

### Acceptance

1. A user lists the models their inference credential can reach, and picks one for a new session —
   in the New Session form, a preset, or `mocactl run --option model=<id>`.
2. A user switches a live session to another model reachable by the same credential; the next turn
   runs on it, with the conversation intact.
3. A model behind LiteLLM that pi's registry does not know runs with its real context window and
   output limit, taken from LiteLLM.
4. A direct Anthropic credential lists and runs Anthropic models through pi's registry, as today.
5. A session that names no model, and every client that predates this change, behaves exactly as
   today: the exchange response and the turn are unchanged.

## 2. Decision summary

- **The model is a session attribute, separate from the credential.** The credential decides who pays
  and where requests go; the model is chosen against it, at creation and by a later switch.
- **The control plane is the model catalog.** It already resolves the secret and the endpoint, so it
  asks the endpoint which models the credential can reach: LiteLLM's `/model/info`, or Anthropic's
  `GET /v1/models` for `api.anthropic.com`. The secret goes nowhere it does not already go, and this
  works in placeholder mode, where the harness never holds the real key.
- **The model's limits are snapshotted on the session** at create and switch time, and travel to the
  data plane in the exchange response, next to `sandboxTier`. There is no catalog lookup on the turn
  path.
- **Two ways to build the model, chosen by the resolved endpoint.** `api.anthropic.com`: pi's registry,
  as today. Any other endpoint: a model synthesized from the snapshotted limits, always, even when
  pi's registry happens to know the id — one path for every gateway model. The wire API stays
  deployment-wide (`SH_MODEL_API`, default Anthropic Messages).
- **No allowlist in MOCA.** Which models a user may call is the LiteLLM key's own model access, which
  `/model/info` already reflects; for direct Anthropic it is what the key's `/v1/models` returns.
- **A switch takes effect at the next exchange.** Every turn reads the model once, so a turn in
  flight keeps its model. No turn-in-progress refusal (§4.3).
- **The harness compacts before a prompt that would not fit** the current model's window, so a
  switch to a smaller model costs one summarization, not a failed request.

## 3. Alternatives considered

| Alternative                                                | Why not                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The harness reads `/model/info` itself, per turn           | In placeholder mode the harness holds only a stand-in key and cannot authenticate the lookup; it adds a gateway round trip to every turn.                                                                                   |
| An operator-declared model catalog in control-plane config | A second list to keep in step with LiteLLM's. LiteLLM already knows which models a key reaches and their limits.                                                                                                            |
| A model field on the credential                            | One credential serves many models; the user would need one credential per model, each holding the same secret.                                                                                                              |
| A `model` field in the `/turn` request body                | The control plane would no longer know or audit which model a session used, and the data plane would trust a caller-supplied value that the exchange today keeps out of the request (as with `configRef` and the tier).     |
| Use pi's registry whenever it knows a LiteLLM model's id   | Two code paths for gateway models, and the registry's limits may not match what the gateway serves under that name.                                                                                                         |
| Refuse a PATCH while a turn runs (`409 turn_in_progress`)  | The control plane sees turns only through best-effort runtime fields (`runtimeFieldsForTurn`, `turn-auth.ts:325`), which a crashed turn leaves stuck. Reading the model once per turn already makes a mid-turn switch safe. |

## 4. Control plane

### 4.1 The catalog

`GET /v1/models?credential=<name>` (auth `api`, not session-scoped) returns the models a credential
reaches:

```json
{
  "credential": "litellm-prod",
  "models": [
    {
      "id": "claude-opus-4-8",
      "contextWindow": 200000,
      "maxTokens": 32000,
      "reasoning": true,
      "vision": true
    },
    {
      "id": "granite-4.1-8b",
      "contextWindow": 131072,
      "maxTokens": 8192,
      "reasoning": false,
      "vision": false
    }
  ]
}
```

`GET /v1/sessions/{id}/models` (auth `api`, session-scoped) returns the same body for the credential a
session's turns run on, resolved exactly as the exchange resolves it. It is what `/model` uses: the
session view does not name the session's credential, and need not.

- `credential` omitted resolves exactly as `POST /v1/sessions` with no credential: the subject's only
  inference credential; the operator fallback (#368) when the subject has none and the fallback is
  enabled; otherwise `credential_required` (none) or `credential_ambiguous` (several).
- The credential must be the caller's own, with consumer `inference`. Its endpoint resolves as in the
  exchange: the credential's own, else `SH_DEFAULT_INFERENCE_ENDPOINT`.
- The limits other than `id` are optional: a gateway that reports none yields `{ "id": "…" }`.

**Adapters**, chosen by the resolved endpoint's host (the check `credential-store.ts:47` already
makes):

- **`api.anthropic.com`** → `GET /v1/models` with `x-api-key`, following `has_more` pages, returning
  ids only. Limits are not needed: the harness takes them from pi's registry (§5.2), and the control
  plane does not depend on pi. An id the registry does not know fails its first turn with
  `requireModel`'s existing unknown-model error.
- **Any other endpoint** → LiteLLM `GET /model/info` with the credential's header. Keep entries whose
  `model_info.mode` is `chat` or absent. Map `model_name` → `id`, `model_info.max_input_tokens` →
  `contextWindow`, `max_output_tokens` → `maxTokens`, `supports_reasoning` → `reasoning`,
  `supports_vision` → `vision`. Dedupe on `model_name` (LiteLLM lists one entry per deployment of a
  load-balanced model) keeping the smallest limits. A `model_name` holding `*` (a wildcard route such
  as `anthropic/*`) is not listed; it is kept as a pattern instead, and an id it matches as a whole
  string (`*` is any run of characters) is accepted at §4.2 as verified, with no limits.

One 5-second bound covers the whole catalog call, all pages included, and a body over 4 MiB is
refused as unavailable. At most 64 wildcard routes are kept from one catalog; the rest are dropped
with a log line. The request URL is built with the URL API: the endpoint's query and fragment are
dropped, so neither can swallow the `/model/info` or `/v1/models` suffix, and an existing path prefix
(`/v1`) is kept. The secret is sent only to the endpoint the credential is already bound to, and
never on a triple the exchange would refuse as misdirected (a raw Anthropic key resolving anywhere
but `api.anthropic.com`, a Bearer token resolving to it): the catalog sends the real secret in every
mode, so that refusal applies before any catalog call, with the exchange's own codes. Responses are
not cached in this slice.

**Host allow-list.** The endpoint is the user's to choose, so the catalog contacts a host only if it
is `api.anthropic.com`, the host of `SH_DEFAULT_INFERENCE_ENDPOINT`, or listed in the operator's
`SH_MODEL_CATALOG_HOSTS` (comma-separated hostnames, matched exactly and case-insensitively against
the endpoint's parsed hostname; a malformed entry refuses to boot). Refusing private or loopback
ranges instead would break the primary case, LiteLLM in-cluster on a private address. A host outside
the allow-list is not fetched: it is treated exactly as an unreadable catalog (the list routes 503;
create and switch accept the id unverified, §4.2), and one server-side line names the host. Every
caller-facing catalog failure — not allow-listed, refused, did not answer, not JSON, no data list, too
large — carries the same message, "the inference endpoint could not list its models"; the host and
the specific reason are logged, never the path, the query or the secret. So the route is no probe
of the control plane's network.

### 4.2 Creating a session with a model

`POST /v1/sessions` accepts an optional `model: string`.

- **The id is in the catalog** → stored with its limits.
- **The id is not in the catalog** → `400 model_unavailable`, naming the credential and the id, never the
  key.
- **The id is not listed, but a wildcard route matches it** (§4.1) → stored without limits,
  `"modelVerified": true`.
- **The catalog cannot be read** (timeout, non-2xx, a gateway without `/model/info`, or an endpoint
  host outside the catalog allow-list, §4.1) → the id is
  accepted **without limits** and the response carries `"modelVerified": false`. The harness then falls
  back to the environment's limits (§5.2), and a wrong id fails on the first turn with the gateway's
  own error. Refusing here would make a gateway outage block every new session.
- **`model` absent** → nothing stored; the session runs on the deployment default, as today.

### 4.3 Switching

`PATCH /v1/sessions/{id}` (auth `api`, session-scoped) with `{ "model": "<id>" }` re-runs §4.2's checks
against the session's own credential and replaces the stored model. `{ "model": null }` returns the
session to the deployment default. Any other body field is `invalid_request`. The switch is audited
(`decision: 'model_changed'`, with the old and new ids).

A turn already in flight read its model at its exchange and keeps it; the next turn's exchange
returns the new one. The response is the session view (§4.5). The record is re-read after the
catalog answers: a session deleted in that window is `session_not_found` and nothing is written, and
the audit's old id is the one stored at write time.

### 4.4 Stored data

Two new fields on `SessionRecord`, read tolerantly:

- `model?: string` — the chosen id; `''` or absent means the deployment default.
- `modelLimits?: { contextWindow?: number; maxTokens?: number; reasoning?: boolean; vision?: boolean }`
  — the snapshot from the catalog; absent when unverified.
  Kept only with the right types: a `contextWindow` above 10,000,000 is dropped, and `maxTokens` is
  clamped down to `contextWindow` when both are present (it becomes every request's `max_tokens`).
  The data plane refuses a window above the same bound as a malformed model.

The previous release ignores both, so a rollback leaves sessions on the deployment default.

### 4.5 Exchange and views

The exchange response (`exchange.ts:299-310`) gains
`model?: { id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; vision?: boolean }`,
present only when the session names a model. For every other session the response is byte-identical
(acceptance 5).

`GET /v1/sessions/{id}` and the list view (`sessionView`, `handlers.ts:327`) gain
`model: string | null`.

### 4.6 Contract

New: two routes (`GET /v1/models`, `GET /v1/sessions/{id}/models`), one route method (`PATCH /v1/sessions/{id}`), one optional request
field, two optional response fields, two error codes (`model_unavailable`, `model_catalog_unavailable`
— the latter is the catalog route's 503). All additive under the change policy: `docs/api/openapi.yaml`
`version` goes `1.0.0` → `1.1.0` with a changelog entry, and the three operations join `routes.ts`. No new
configuration.

## 5. Data plane and harness

### 5.1 Carrying the model

`TurnAuth` (`packages/knative-server/src/turn-auth.ts:26`) gains `model?` as the exchange returned it.
`buildConfig(auth)` copies it into a new `TurnConfig.sessionModel`. It does **not** set
`TurnConfig.model`: `/runs` reads that field too (`run-leaf.ts:400`, `runPromptLeaf`) and would then hand pi's registry
an id it may not know. Only the interactive turn (`executeTurn`) reads `sessionModel`.

### 5.2 Building the model

A new `sessionModelFor(sessionModel, baseUrl)` builds the model when `sessionModel` is present; with
none, `requireModel` runs unchanged. With one:

- **The resolved base URL's host is `api.anthropic.com`** → `getModel('anthropic', id)` from pi's
  registry, exactly as today.
- **Any other base URL** → a synthesized model whatever `SH_MODEL_CUSTOM` says: `anthropic-messages`,
  or `openai-completions` when `SH_MODEL_API` says so, built by the existing
  `synthesizeCustomModel` / `synthesizeOpenAICompletionsModel` with limits from `modelLimits`, falling
  back field by field to `SH_MODEL_CONTEXT_WINDOW` / `SH_MODEL_MAX_TOKENS` and their defaults.
  `reasoning` and `vision` (→ `input: ['text', 'image']`) come from the limits too. `SH_MODEL_HEADERS`
  still applies.

`applyModelGateway` then layers the base URL and the per-subject credential on top, as it does today.

### 5.3 Compacting before a prompt that would not fit

Pi checks for compaction after each reply and again inside `prompt()` before sending
(`_checkCompaction(lastAssistant, false)`,
`pi-fork/packages/coding-agent/src/core/agent-session.ts:1068`), against the active model's window, and
on an overflow error it compacts and retries. Both checks read the last reply's reported usage:
counted by whichever model produced it — after a switch, the old one — and not consulted at all when
that reply predates the latest compaction. After a switch to a smaller window the first turn could
therefore send a request that cannot fit. In `executeTurn`, after the agent session is built and before `prompt()`
(`run-turn.ts:978` onward): when compaction is enabled and `estimateContextTokens(messages)` exceeds
`model.contextWindow − reserveTokens`, call `session.compact()` first. The check does not depend on a
switch having happened, so it needs no stored "previous window". It runs through pi's own compaction,
so the M5 checkpoint extension sees it as it sees any other.

As built, the estimate is the sum of pi's exported `estimateTokens` (chars/4) over the messages:
`estimateContextTokens` is not exported from pi's package entry. A compaction the turn's own abort
cancels is logged as cancelled, not as a failure. The check is skipped, silently, when compacting
cannot help: the branch already ends in a compaction (pi would throw "Already compacted"), or the
window is no larger than `reserveTokens + keepRecentTokens` (it stays over the threshold even after
compacting).

A turn whose model differs from the last one recorded on the branch (the latest `model_change` or
assistant reply) appends a `model_change` through pi's `SessionManager.appendModelChange` before
`prompt()`: pi records only a new session's model, so without it the transcript and
`buildSessionContext().model` would go on naming the first one. Resumption never depended on it —
the model is always passed explicitly.

## 6. `mocactl`

- **The `model` session option.** A third entry in `SESSION_OPTION_FIELDS`, resolved after
  `inferenceCredential`. Its choices depend on the credential already chosen, so `source` gains the
  values resolved so far: `source(api, values)`. It calls `GET /v1/models?credential=<chosen>`,
  and labels choices `claude-opus-4-8  200k ctx` (the id alone when the catalog reports no limits).
  The first choice is always the deployment default (sending no `model`), so a single listed model
  is never pinned unasked; it is preselected unless a model was used last, which is then preselected.
  Like the tier, it is
  `serverMayResolve` and `serverDefaults`: with no catalog (an older control plane's 404, or any 503) the
  field is skipped and the session runs on the deployment default. Presets and `run --option model=…`
  gain it with no other change.
- **The `/model` command** (`ctrl+x m`, in a session only). It opens a list of the session
  credential's models with the current one marked (a current id the catalog no longer lists gets its
  own `(not listed)` row, under the cursor) and calls `PATCH /v1/sessions/{id}` on selection;
  `/model <id>` switches directly. The PATCH is sent at once, even while a turn streams: that turn
  read its model at its exchange, so the switch applies from the next one, and the toast says so.
  The list comes from `GET /v1/sessions/{id}/models`.
- **An explicit model with no catalog.** When the catalog is unavailable, `--option model=<id>` (or
  a preset's model) is sent as given, for the server to accept unverified (§4.2), rather than
  blocking the field.
- **The status line** shows the session's model, or `default` when the session names none (the
  control plane does not know the harness's `SH_MODEL`).

## 7. Failure modes

| Situation                                              | Behaviour                                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway down when listing                              | `503 model_catalog_unavailable`; mocactl skips the field and creates the session on the default.                                                                        |
| Gateway down at create or switch with an explicit id   | Accepted unverified (`modelVerified: false`); environment limits apply; a wrong id fails at the first turn with the gateway's error.                                    |
| Gateway down during a turn                             | Unchanged from today: the turn fails. Running sessions never consult the catalog.                                                                                       |
| Id dropped from the key's model access after selection | The turn fails with the gateway's error; the user switches with `/model`.                                                                                               |
| Credential deleted mid-session                         | Unchanged: the exchange refuses (`credential_required`). The model is irrelevant.                                                                                       |
| Switch to a smaller window                             | The next turn compacts first (§5.3).                                                                                                                                    |
| Switch to a window smaller than the conversation       | Pi compacts with the new model, so a history larger than its whole window cannot be summarized and every turn fails; switch back with `/model`, or start a new session. |
| Switch across model families behind LiteLLM            | LiteLLM translates the stored Anthropic-format history; provider-specific blocks it cannot carry (thinking signatures) are its to drop.                                 |
| Older mocactl, newer control plane                     | No `model` sent; the session runs on the default.                                                                                                                       |
| Newer mocactl, older control plane                     | `/v1/models` 404s; the field is skipped. `/model` reports that the control plane does not support switching.                                                            |

## 8. Testing

- **Control plane.** Catalog adapters against a fake LiteLLM (`/model/info` with duplicates, non-chat
  modes, missing limits) and a fake Anthropic `/v1/models` (pagination, ids pi does not know); create
  and PATCH validation, including the unverified path; audit of `model_changed`; the exchange response
  byte-identical for a session without a model; tolerant reads of a record without the new fields.
- **Harness.** `requireModel` per endpoint type, with and without limits, under each `SH_MODEL_API`;
  the pre-prompt compaction check with a history above and below the threshold.
- **mocactl.** The model field's dependency on the chosen credential; skipping on 404 and 503; `/model`
  with and without an argument; presets carrying `model`.
- **Live.** A `kind-ci` smoke: create a session on one model name, switch with PATCH, and assert the
  next turn's request named the other (the mock model echoes it). kind-ci's mock model listens on the
  harness pod's loopback, out of the control plane's reach, so this exercises the unverified path end
  to end; the catalog adapters are covered by the unit tests above.

## 9. Scope — explicitly not building

- A model choice on `/runs` envelopes: they already carry `model` (`run-leaf.ts:400`, `runPromptLeaf`).
- A per-session wire API: `SH_MODEL_API` stays deployment-wide.
- A MOCA-side model allowlist or per-model cost policy: the gateway key's model access is the policy.
- Caching the catalog.
- Cost display: the client still does not know model pricing.

**Follow-up.** Compacting with the outgoing model at switch time, so a switch to a window smaller than
the conversation can succeed (§7), is planned; this slice compacts with the model the turn runs on.
