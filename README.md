# dsh-behuman

English | [中文](README.zh.md)

Long-term memory and self-evolving skills for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## The problem

**Every session starts from zero.** You tell the agent your project uses PostgreSQL; next session it asks again. You correct how it explains things; next session it's back to the same habit.

**The same mistakes come back.** Something took you three tries to get working last week. This week it's three tries again, because nothing remembered how you got through it.

## What it does

- **Remembers you.** Your preferences, your corrections, your project's state — carried across sessions.
- **Gets better on its own.** A working approach gets written down as a skill, so the next similar task starts already knowing.
- **Costs you nothing to run.** No commands to type, no memory to manage. Install it and it works.

## How it works

```
You talk to the agent
   │
   ├─ Something worth keeping comes up → it writes it down
   │    · a fact about you or your project     → a memory
   │    · a way of working that just succeeded → a skill
   │
   └─ Next session, it starts already knowing.
```

Two things are worth knowing about how it decides:

- **It only writes down what actually worked.** A lesson from an unsolved problem is a dead end wearing a method's clothes, so nothing gets recorded until the task is finished, the error is fixed, the approach ran through.
- **It forgets nothing behind your back.** Memories are plain Markdown files you can open, read, edit, or delete.

## Install

```bash
dsh plugin --profile <your-profile> add @goodddgrades/dsh-behuman
```

That's it — there is nothing to enable afterwards.

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
