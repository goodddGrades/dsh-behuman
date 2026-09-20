# Design notes

Why this plugin is built the way it is. Not needed to use it — see [README](README.md) for that.

## Table of contents

- [Four decisions](#four-decisions)
- [Verification](#verification)
- [Development](#development)
- [Environment notes](#environment-notes)

## Four decisions

**"Only write it after it worked" is wording, not machinery.**
Every trigger phrase in the standing rules is in the completed aspect —
*after completing*, *after fixing*, *after discovering*. A lesson distilled from
an unsolved problem is a dead end wearing a method's clothes. An earlier design
used an open-case/closed-case state machine for this; a sentence does it better,
and needs no state.

**The catalog is derived, never authored.**
Every write regenerates `MEMORY.md` from `memories/`. A memory whose file exists
but whose catalog line does not is invisible forever, and the model is the wrong
component to keep two things in sync: it reliably judges "this is worth keeping"
and unreliably remembers "now go register it".

**The reviewer is a `spawn`, and the window travels in the prompt.**
`fork` looks like the right provider — it hands the child the parent's
conversation for free. It cannot work here: a forked child only sees *completed*
turns, and this pass runs at `agent/turn-stopping`, before the turn it is meant
to review has been committed. (It also requires the parent loop to still be
active, which it is not by then.) So the checkpointed window is rendered into
the prompt.

**The reviewer proposes; code decides.**
The child runs with an empty tool whitelist and returns structured data. Every
write then goes through the same validation, dedupe, filename generation and
catalog regeneration as a model-invoked `remember` call — the review path gets
no shortcut. It does not modify existing skills either: a name collision is
refused, because the agent that actually *used* a skill is the one that knows
what was wrong with it.

## Verification

| | Status |
|---|---|
| Pure logic — store, clue scan, naming rules, report application, transcript rendering | ✅ 63 smoke checks (`npm test`) |
| Builds from published npm dependencies alone | ✅ no local checkout required |
| Type check against dsh's real declarations | ✅ 0 errors |
| Loads in a real dsh session | ✅ |
| Rules / catalog / tool schema reach the model | ✅ found verbatim in session logs |
| Model calls `remember` and the file lands | ✅ on a real session |
| Cross-session recall | ✅ fresh session, no context, answered correctly |
| Main agent writes a class-level skill | ✅ on a real session |
| Catch-up pass dispatches a reviewer | ✅ a child session with `origin: subagent` appears |
| Catch-up pass runs to completion | ✅ the reviewer returned a structured report |
| Installs from a packed tarball into a fresh profile | ✅ mounted, and all contributions reached the model |

**What the completed review pass actually did.** It reported nothing, on purpose:
the window's tool results were empty, so it could not confirm the task had
finished. Its own reasoning — *"no evidence the task is closed; writing a
'how to map a repo's build flow' skill here would be pure invention"* — is the
"only write it after it worked" rule doing its job on a negative case, which is
the hard direction.

**Reading that run.** The one-shot `headless` CLI exits as soon as the main
answer is produced, which kills the background reviewer mid-startup. The
completion run above was observed by holding the process open; interactive
sessions do not have this problem. `tests/session-probe.mjs` decodes a session
log and reports whether this plugin's contributions reached the model.

## Development

```bash
npm install
npm run build     # tsc -p tsconfig.json
npm test          # smoke tests on stock Node (type stripping)
```

`tsconfig.json` is the publishable build config: it resolves `@deepseek-ai/*`
from `node_modules` like any consumer would.

Two extra configs exist for developing against a dsh **source checkout** instead
of published packages. Neither is needed to build or publish:

- `tsconfig.check.json` — type check against a checkout's built declarations
- `tsconfig.build.json` — emit while resolving types from that checkout

Both hardcode a relative path to the checkout; edit the `paths` block to match
your layout. They exist because a checkout has no `node_modules` entry for its
own workspace packages from outside the repo.

## Environment notes

- dsh requires Node `^22.19.0 || >=24`. On older Node the CLI's
  `import.meta.main` guard is `undefined` and the process exits silently with no
  output — which looks like a hung command, not a version error.
- Run the built CLI (`node apps/cli/lib/bin.js …`), not `pnpm dsh`. Under tsx,
  workspace packages load twice — once from source via `tsconfig` `paths`, once
  from `lib/` via package `exports` — and any package using module-local
  `Symbol()` keys for cross-package handshakes breaks. Upstream discussion:
  `deepseek-ai/deepseek-harness#7035`.
- Session logs are append-only **multi-frame** zstd files. Node's
  `zstdDecompressSync` decodes only the first frame, so the frames have to be
  split on the magic (`28 b5 2f fd`) and decoded individually.
