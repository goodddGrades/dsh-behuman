# dsh-memory

Durable cross-session memory and self-evolving skills for the **DeepSeek Harness**.

> **Status: pre-release.** The memory loop and self-written skills are verified on a real dsh; the background review pass has only been observed dispatching, not completing (see [Verification](#verification)).

---

## What it does

```
① Standing rules (system prompt, static — cached prefix)
   ├─ memory rules: when to record, how to phrase, what never to record
   └─ skill rules: after finishing a complex task / fixing a tricky error /
                   discovering a non-trivial workflow → write a SKILL.md

② The main agent writes — primary path, zero extra cost
   ├─ calls `remember`     → writes memories/<slug>.md → code rebuilds MEMORY.md
   └─ writes a SKILL.md    → dsh's skill-filesystem watcher discovers it, no restart

③ Catch-up pass (background, only when writes stop happening)
   ├─ tool-call counter trips → spawn a reviewer subagent
   ├─ it proposes; code decides — every write takes the same gate as `remember`
   └─ a rejected name, a malformed entry, a key-looking string: dropped, not written

④ The catalog (dynamic context, regenerated from disk every assembly)
   one line per memory:  - [title](memories/x.md) — one-line description
   the model reads a line it recognizes and opens the file itself
```

No vector store, no SQLite, no cron, no daemon.

## Install

```bash
dsh plugin --profile <profile> add @goodddgrades/dsh-behuman
```

Writing a skill needs no tool: dsh's `skill-filesystem` provider watches its
roots, so a `SKILL.md` written with an ordinary file tool is picked up without a
restart.

## Configure

| Key | Default | Meaning |
|---|---|---|
| `dir` | `.dsh/memory` | Memory root — holds `MEMORY.md` (the catalog) and `memories/` (one file per memory). Relative paths resolve against the process working directory, so each project gets its own memory. |
| `skillsDir` | `.agents/skills` | Skill root the standing rules point the model at, and where a reviewed skill is written. |
| `nudgeInterval` | `10` | Tool calls since the last pass before one runs. `0` disables the catch-up pass entirely, leaving only the main agent. |
| `reviewBackend` | `spawn` | Subagent provider for the catch-up pass. Leave it on `spawn` — see below. |
| `reviewTimeoutMs` | `60000` | Reviewer timeout. |
| `reviewMaxTokens` | `2048` | Reviewer output cap. |

## Design notes

**"Only write it after it worked" is wording, not machinery.**
Every trigger phrase in the standing rules is in the completed aspect —
*after completing*, *after fixing*, *after discovering*. A lesson distilled
from an unsolved problem is a dead end wearing a method's clothes. An earlier
design used an open-case/closed-case state machine for this; a sentence does it
better, and needs no state.

**The catalog is derived, never authored.** Every write regenerates `MEMORY.md`
from `memories/`. A memory whose file exists but whose catalog line does not is
invisible forever, and the model is the wrong component to keep two things in
sync: it reliably judges "this is worth keeping" and unreliably remembers "now
go register it".

**The reviewer is a `spawn`, and the window travels in the prompt.**
`fork` looks like the right provider — it hands the child the parent's
conversation for free. It cannot work here: a forked child only sees *completed*
turns, and this pass runs at `agent/turn-stopping`, before the turn it is meant
to review has been committed. (It also requires the parent loop to still be
active, which it is not by then.) So the checkpointed window is rendered into
the prompt.

**The reviewer proposes; code decides.** The child runs with an empty tool
whitelist and returns structured data. Every write then goes through the same
validation, dedupe, filename generation and catalog regeneration as a
model-invoked `remember` call — the review path gets no shortcut. It does not
modify existing skills either: a name collision is refused, because the agent
that actually *used* a skill is the one that knows what was wrong with it.

## Verification

| | Status |
|---|---|
| Pure logic — store, clue scan, naming rules, report application, transcript rendering | ✅ 63 smoke checks (`npm test`) |
| Builds from published npm dependencies alone | ✅ no local checkout required |
| Type check against dsh's real declarations | ✅ 0 errors |
| Loads in a real dsh session | ✅ |
| Rules / catalog / tool schema reach the model | ✅ found verbatim in session logs |
| Model calls `remember` and the file lands | ✅ on a real session |
| **Cross-session recall** | ✅ fresh session, no context, answered correctly |
| **Main agent writes a class-level skill** | ✅ on a real session |
| Catch-up pass dispatches a reviewer | ✅ a child session with `origin: subagent` appears |
| Catch-up pass completes and writes | ⚠️ not observed end to end |

**Why the last row is open.** The one-shot `headless` CLI exits as soon as the
main answer is produced, killing the background reviewer mid-startup. Interactive
sessions do not have this problem. The write path itself — report in, files out —
is covered by `tests/apply.smoke.mjs`, which needs no subagent service.

## Development

```bash
npm install
npm run build     # tsc -p tsconfig.json
npm test          # smoke tests on stock Node (type stripping)
```

### Working against a dsh checkout

`tsconfig.json` is the publishable build config: it resolves `@deepseek-ai/*`
from `node_modules` like any consumer would.

Two extra configs exist for developing against a dsh **source checkout** instead
of published packages. Neither is needed to build or publish:

- `tsconfig.check.json` — type check against a checkout's built declarations
- `tsconfig.build.json` — emit while resolving types from that checkout

Both hardcode a relative path to the checkout; edit the `paths` block to match
your layout. They exist because a checkout has no `node_modules` entry for its
own workspace packages from outside the repo.

### Environment notes

- dsh requires Node `^22.19.0 || >=24`. On older Node the CLI's
  `import.meta.main` guard is `undefined` and the process exits silently with no
  output — which looks like a hung command, not a version error.
- Reading session logs: they are append-only **multi-frame** zstd files. Node's
  `zstdDecompressSync` decodes only the first frame, so the frames have to be
  split on the magic (`28 b5 2f fd`) and decoded individually.
  `tests/session-probe.mjs` does this and reports whether this plugin's
  contributions reached the model.

## Known limitations

- **No retrieval.** The catalog is one line per memory, injected every turn.
  Past roughly 100 memories that stops being cheap. The upgrade path is a
  searchable index *derived* from the Markdown, never a database that replaces
  it.
- **No forgetting.** Memories are removed only when found to be wrong.
- **No concurrent-write protection.** One instance at a time.
- `REINFORCE_THRESHOLD` (0.82, in `src/store.ts`) decides when a new memory is
  treated as re-confirming an existing one rather than adding a second copy. Too
  loose merges distinct facts; too tight accumulates near-duplicates. Tune it
  against real use.

## License

MIT — see [LICENSE](LICENSE).
