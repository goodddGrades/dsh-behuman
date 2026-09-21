# dsh-behuman

English | [中文](README.zh.md)

Long-term memory and self-evolving skills for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

People who work together for a month know things about each other — what the other cares about,
what they have already ruled out. dsh does not: tell it your project uses PostgreSQL and it asks
again next session.

This plugin fills that gap.

## What it does

- **Remembers you.** Your preferences, your corrections, your project's state — carried across sessions.
- **Gets better on its own.** A working approach gets written down as a skill, so the next similar task starts already knowing.
- **Nothing to operate.** No commands to type, no memory to manage. Install it and it works.

## How it works

Two things run once it is installed.

### 1. While you are talking, the agent writes things down

It is already in the conversation, so noticing something worth keeping costs it nothing — it just
writes a file. No extra model call.

When it writes:

| A memory, when | A skill, when |
|---|---|
| you mention a preference, a habit, or a project convention | it finishes something involved (5+ tool calls) |
| you correct it and it then does it your way | it fixes a tricky error |
| it works out an environment fact worth keeping | it discovers a workflow worth reusing |

Both columns sit on one condition: **it has to have actually worked**. An error that is still
broken, or a correction it has not yet applied successfully, is not written down. A "method"
summarised from an unsolved problem usually does not survive being used the next time either.

One more rule: **write facts, not commands**. "The user prefers short answers" gets written;
"always answer briefly" does not. The second one gets re-read as an instruction in a later session
and can override what you actually want then.

### 2. When it did not write anything, it goes back and looks

Models forget. There is no way around that. So after **10 tool calls with nothing written**
(the count is configurable), it runs a review pass over that stretch of conversation to see what
was missed.

This is the only part of the plugin that costs an extra model call, and it only runs while you are
not working.

### Both writers go through the same checks

Whether it can be written at all, whether it duplicates something, what the file is called,
whether the catalog needs rebuilding — no step is skipped. The review pass gets no privileges.

### The whole flow

```
WRITE
  ├─ as you talk:  written on the spot
  └─ catch-up:     a later pass fills the gaps
        │
        ▼  same checks either way
STORE
  ├─ memories/     one .md per fact
  └─ skills/       one SKILL.md per class of task
        │
        ▼
RECALL
  └─ the catalog rides in the prompt; the agent opens a file when a line earns it
```

There is no retrieval. Nothing is searched and your question is never used as a query — the
catalog is simply part of the context, and opening a file is the agent's own call. So remembering
costs no extra time.

The catalog does take up room, though, and it keeps growing. One line per memory, in front of the
agent every turn. A few dozen is nothing; a few hundred is real money. That is the known ceiling
of this design — the way past it is a searchable index generated from these Markdown files, not a
database that replaces them.

### Two more things

- **Saying the same thing twice strengthens a memory.** When a new memory closely overlaps an existing one, it updates that one instead of adding a second. Something you keep bringing up is evidence that it matters.
- **Nothing is hidden from you.** Memories are ordinary Markdown files. Open them, read them, edit them, delete them.

## Install

`dsh` runs one profile at a time — a named set of plugins and settings that you choose when you
launch it. The ones that ship with dsh are `web`, `tui`, and `headless`. Install into the one you
actually launch with:

```bash
dsh plugin --profile web add @goodddgrades/dsh-behuman     # if you run `dsh web`
dsh plugin --profile tui add @goodddgrades/dsh-behuman     # if you run `dsh tui`
```

That is the whole install, and there is nothing to enable afterwards. The profile is created the
first time you use it, so this works even if you have never launched it before.

If you use more than one profile, install into each of them.

### Or hand it to your agent

If you are already in a dsh session, you do not have to type any of that:

> Install the dsh-behuman plugin — https://github.com/goodddGrades/dsh-behuman

Your agent can read that page and run the install itself.

Installing straight from GitHub builds the plugin on your machine, so dsh will stop and ask you to
authorize that once. It tells you exactly what to add — the build is this package's own `prepare`
script, and nothing runs it until you say so.

## Where your memories live

```
<your working directory>/.dsh/memory/
├── MEMORY.md          the catalog — one line per memory
└── memories/          the memories themselves, one Markdown file each
```

Plain text, yours to read and edit. Each project directory gets its own memory, so switching
projects switches what the agent remembers.

Skills are written to `.agents/skills/` — the same place hand-written skills live, in the format
dsh already reads.

Auto-written skills are marked. Each one carries this in its frontmatter:

```yaml
metadata:
  generated-by: dsh-behuman
```

So you can tell at a glance which skills the agent wrote and which ones you did. It updates its
own; it never touches yours — a hand-written skill in the way is a refusal, not an overwrite.

## Configuration

Every option has a default; you only need this if you want to change something.

| Option | Default | What it does |
|---|---|---|
| `dir` | `.dsh/memory` | Where memories are kept. |
| `skillsDir` | `.agents/skills` | Where skills are written. |
| `nudgeInterval` | `10` | Tool calls without a write before the agent double-checks itself. `0` turns that off. |
| `reviewBackend` | `spawn` | Subagent used for that double-check. Leave it alone. |
| `reviewTimeoutMs` | `60000` | How long that double-check may take. |
| `reviewMaxTokens` | `2048` | Its output limit. |

## License

MIT — see [LICENSE](LICENSE).
