# Auto models

Auto models are virtual models the Kimchi backend routes itself: you select
one, every request goes out under the virtual id, and the backend picks and
serves a concrete model, reporting the pick in the OpenAI response `model`
field. `auto` and `auto-beta` are current examples. The convention is general:
a model is routed virtual when it is a `kimchi-dev` catalog model whose id
starts with `auto` (`isAutoRoutedModel`); concrete models never use that
namespace.

Auto models are useful when you want Kimchi to choose between the models
available to you without switching models manually for every task.

## Selecting an auto model

Auto models appear in the model picker, on the command line (`--model auto`),
and in ACP model lists exactly when the backend catalog advertises them to
your account. There is no client-side gate or flag — what you can see is what
the backend serves. The harness treats them as ordinary `kimchi-dev` catalog
entries: no special authentication, endpoint, or custom provider.

## How routing works

Every request goes to the backend as the virtual id; the backend selects the
concrete model, serves the request, and reports the pick in the response
`model` field. pi-ai surfaces that on the assistant message as
`responseModel` (upstream, since pi-ai 0.71.0), and the auto-model extension
(`src/extensions/auto-model/`) uses it to:

1. **Learn the pick per response** — maps `responseModel` to the catalog
   model and announces it as `<virtual id> picked <model>.` in the transcript
   (kept out of LLM context).
2. **Re-sync capabilities** — copies the routed model's real context window,
   max tokens, reasoning, and thinking map onto the session descriptor, so
   compaction thresholds and thinking controls match what actually served.
3. **Track reroutes** — the backend may route each request to a different
   model (for example, a vision-capable model for an image prompt), so a new
   notice is emitted and capabilities re-synced whenever the pick changes.

The interface keeps showing the auto model as your selection before and after
routing. Once a pick is known, surfaces that have room for it render
`auto (<routed model>)` — the prompt summary and ACP model lists included.
Surfaces resolve the pick through the shared per-session
routing state (`state.ts`), keyed by the requested id.

## ACP notification

ACP clients learn about pick changes through a `_kimchi.dev/routed_model`
ext notification, pushed exactly when the transcript entry above is
appended — once per change, silent when a later turn lands on the same
model. The payload is `{ sessionId, requestedId, routedId }`: both ids are
full `provider/modelId` refs — the same format as the per-message
attribution `_meta` (see [ACP model attribution](./acp-model-attribution.md))
and the session's model list, so `requestedId` compares directly against
`SessionModelState.currentModelId`. The requested ref is the virtual id
(`kimchi-dev/auto`); `routedId` is the served model's ref, or
`provider/raw-id` when the catalog doesn't know the pick. Like all
kimchi.dev ext notifications it is
not advertised in `_meta`; clients that don't know it ignore it per JSON-RPC
rules.

The harness itself stays id-agnostic: it appends — and so notifies — whenever
a kimchi-dev response's served model differs from the requested id, even if
that request was a pinned concrete selection the backend redirected. Filtering
to Auto turns is therefore client-side: key the per-turn label on
`requestedId`. Today the backend only routes virtual ids (see
`isRoutableProvider` in the auto-model extension), so a redirected pin is not
expected; the harness just doesn't assume it away on the client's behalf.

A client that wants a label on every turn keeps the last pick per session
and applies it to subsequent messages, the same way it replays the persisted
entries on reload.

## Failures

There is no client-side routing step to fail. If the backend cannot serve a
request, the provider error surfaces like any model error; submit again or
select a concrete model with `/model`.

## Session lifecycle

The routing decision belongs to the backend, per request:

- A new session on an auto model starts unresolved; the first response
  reveals the pick.
- Each request may land on a different concrete model.
- Resuming a session restores the auto model as the selection (and the last
  persisted pick notice); the backend routes each new request fresh.
- Switching away and back re-syncs against the next response.
- A concrete model provided on the command line when resuming overrides the
  auto model and is persisted as the new default (it is an explicit user
  choice).

Each local subagent that inherits an auto model requests the virtual id too;
the backend routes every session independently.

## Main-session behavior

For the main session (not subagents), the auto-model extension additionally:

- **Rolls every fresh session into the default** — a fresh main session
  always comes up on `auto` when the backend catalog advertises it. A manual
  switch away is honoured for the session it happens in, but the next new
  session rolls back to Auto: for entitled accounts Auto IS the default, not
  a one-time install. The rollback is provider-agnostic — switching to
  another provider's model (e.g. Anthropic's Claude) rolls back too. An
  explicit launch-time `--model` still wins.
- **Persists explicit choices** — an explicit launch-time `--model` over an
  auto session is user-initiated and persists.
- **Unwraps saved defaults** — a persisted default is never wrapped in
  multi-model.

## Attribution

The persisted assistant message keeps `message.model` as the requested
virtual id and stores the concrete pick in `responseModel`. Requests are
always sent as the virtual id (never the concrete pick), while the transcript
records which concrete model served each response. This keeps attribution
honest and makes resume work without extra bookkeeping.

## Permissions classifier model (`modelRoles.classifier`)

The permissions classifier decides whether a tool call needs confirmation in
auto mode. Configure it with `modelRoles.classifier` in the user-level
`~/.config/kimchi/harness/settings.json`. The value is a string or an ordered
array of `provider/model-id` refs; the classifier tries them in order.

```json
{
  "modelRoles": {
    "classifier": ["kimchi-dev/glm-5.3-flash", "anthropic/claude-haiku-4-5"]
  }
}
```

- **Default:** `kimchi-dev/deepseek-v4-flash-0731`, `kimchi-dev/glm-5.3-flash`,
  `kimchi-dev/minimax-m3` (`DEFAULT_MODEL_ROLES.classifier`). With no config,
  behaviour is unchanged.
- **Strict replace:** a configured list fully replaces the defaults. If none
  of the refs resolve, the classifier is unavailable and calls needing
  classification ask for confirmation, or are blocked when there is no UI.
  If only some refs are missing they are skipped and you get a degraded
  warning. Warnings point to `modelRoles.classifier`.
- **User scope only:** project files (`.pi/settings.json`,
  `.kimchi/permissions.json`, `.kimchi/permissions.local.json`) cannot change
  it, so a repository cannot weaken the safety classifier.
- **Not for delegation:** classifier models are not subagent models. They
  never appear in orchestrator role lists or allowed Agent models.
- **Request tags:** the `source:classifier` cost-tracking tag is sent only to
  Kimchi providers; other providers get no `tags` field.

### `/multi-model`

The TUI and ACP both have a "Classifier" multi-select row (ACP uses a
select-based `[x]`/`[ ]` list with a Done entry). The picker cannot reorder:
newly ticked models are appended last, behind any still-ticked (possibly
failing) defaults. To make a new model primary, untick the others or edit
`settings.json` directly.

The picker only offers Kimchi (`kimchi-dev/...`) catalog models plus models
that are already configured. To use a direct provider model as the classifier
(for example `anthropic/claude-haiku-...`), first add it to
`modelRoles.classifier` in `settings.json`; after that it appears in the
picker. Other roles work the same way. Only Kimchi models receive request
tags.

The startup check (`validateModelRoles`) intentionally skips
`modelRoles.classifier`, so a misspelled classifier model is not reported at
startup. It surfaces as the classifier health warning on the first classified
tool call.

### Upgrade and downgrade

There is no migration. Defaults live in code, and `/multi-model` persists
`classifier` only when it differs from the default, so users who never
customize keep tracking future default changes. Older kimchi versions ignore
the key, but if they save via `/multi-model` they drop it.

### Restart required for hand edits

Roles are cached, so hand edits to `settings.json` need a restart to take
effect. This matters most for the long-running ACP server: restart the IDE's
agent process. Changes made via `/multi-model` apply immediately.
