# dsh-behuman

English | [中文](README.zh.md)

Long-term memory and self-evolving skills for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**The name is the goal — dsh that knows you the way a person does.**

Someone who has worked with you for a month knows what you care about, how you like to be told
things, and which approaches you have already ruled out; they also stop repeating a mistake once
it is fixed.

## The problem

**Every session starts from zero.** You tell the agent your project uses PostgreSQL; next session it asks again. You correct how it explains things; next session it's back to the same habit.

**The same mistakes come back.** Something took you three tries to get working last week. This week it's three tries again, because nothing remembered how you got through it.

## What it does

- **Remembers you.** Your preferences, your corrections, your project's state — carried across sessions.
- **Gets better on its own.** A working approach gets written down as a skill, so the next similar task starts already knowing.
- **Nothing to operate.** No commands to type, no memory to manage. Install it and it works.

## How it works

### Two paths write

**The agent writes as it goes.** It is already in the conversation, so noticing costs it nothing:
a fact about you, a correction you made, a way of working that just succeeded.

**A catch-up pass writes what it missed.** Models forget to do this — measurably, not
occasionally. So when tool calls pile up without a write, a second pass goes back over that
stretch of conversation and reports what was skipped. It costs one small model call, and only
when the first path has gone quiet.

**Both paths end at the same gate** — same validation, same deduplication, same filename rules.
The automatic path gets no shortcut.

### The whole flow

```
WRITE
  ├─ primary:   the agent writes as it goes
  └─ catch-up:  a later pass fills the gaps
        │
        ▼  both take the same gate
STORE
  ├─ memories/     one .md per fact
  └─ skills/       one SKILL.md per class of task
        │
        ▼
RECALL
  └─ the catalog rides in the prompt. The agent opens a file when a line earns it
```

**There is no lookup step.** Nothing is searched, and your question is never used as a query — the
catalog is simply part of the context, and opening a file is the agent's own call. Recall costs no
extra time.

**The catalog is not free, though, and it grows.** One line per memory, in front of the agent every
turn. At a few dozen memories that is nothing; at a few hundred it is real money. That is the known
ceiling of this design, and the way past it is a searchable index derived from these files — never a
database that replaces them.

### Three things worth knowing about how it decides

- **It only writes down what actually worked.** A lesson from an unsolved problem is a dead end wearing a method's clothes, so nothing gets recorded until the task is finished, the error is fixed, the approach ran through.
- **Saying the same thing twice makes a memory stronger, not duplicated.** A near-repeat updates the original instead of adding a second copy — repetition is evidence it matters.
- **It forgets nothing behind your back.** Memories are plain Markdown files you can open, read, edit, or delete.

## Install

`dsh` runs one **profile** at a time — a named set of plugins and settings that you choose when you
launch it. The ones that ship with dsh are `web`, `tui`, and `headless`.

Install into the profile you actually launch with:

```bash
dsh plugin --profile web add @goodddgrades/dsh-behuman     # if you run `dsh web`
dsh plugin --profile tui add @goodddgrades/dsh-behuman     # if you run `dsh tui`
```

That is the whole install, and there is nothing to enable afterwards. The profile is created the
first time you use it, so this works even if you have never launched it before.

If you use more than one profile, install into each of them.

### Or hand it to your agent

If you are already in a dsh session, you do not have to type any of that:

> Install the dsh-behuman plugin — https://github.com/goodddgrades/dsh-behuman

Your agent can read that page and run the install itself.

Installing straight from GitHub **builds the plugin on your machine**, so dsh will stop and ask you
to authorize that once. It tells you exactly what to add — the build is this package's own
`prepare` script, and nothing runs it until you say so.

## Where your memories live

```
<your working directory>/.dsh/memory/
├── MEMORY.md          the catalog — one line per memory
└── memories/          the memories themselves, one Markdown file each
```

Plain text, yours to read and edit. Each project directory gets its own memory, so switching projects switches what the agent remembers.

Skills are written to `.agents/skills/` — the same place hand-written skills live, in the format dsh already reads.

**Auto-written skills are marked.** Each one carries this in its frontmatter:

```yaml
metadata:
  generated-by: dsh-behuman
```

So you can tell at a glance which skills the agent wrote and which ones you did. It updates its own; it never touches yours — a hand-written skill in the way is a refusal, not an overwrite.

## Configuration

Every option has a sensible default; you only need this if you want to change something.

| Option | Default | What it does |
|---|---|---|
| `dir` | `.dsh/memory` | Where memories are kept. |
| `skillsDir` | `.agents/skills` | Where skills are written. |
| `nudgeInterval` | `10` | How many tool calls may pass without a write before the agent double-checks itself. `0` turns that off. |
| `reviewBackend` | `spawn` | Subagent used for that double-check. Leave it alone. |
| `reviewTimeoutMs` | `60000` | How long that double-check may take. |
| `reviewMaxTokens` | `2048` | Its output limit. |

## Status

**Pre-release.** Everything above works — memories are written, recalled across sessions, and skills get written on their own. It has not yet been run by anyone but its author.

## License

MIT — see [LICENSE](LICENSE).
