/**
 * Durable cross-session memory for the DeepSeek Harness.
 *
 * The plugin contributes three things:
 *
 * - **Standing rules** in the system prompt that tell the model when to
 *   record a fact (`remember`) and when to write or revise a skill. The model
 *   decides on its own; this is the primary path, and it costs nothing.
 * - **The memory catalog** as dynamic prompt context: one line per memory,
 *   regenerated from disk on every assembly. The model reads a line it
 *   recognizes and opens the file itself, so retrieval costs nothing until it
 *   is actually needed.
 * - **A background catch-up pass** that runs when tool calls have accumulated
 *   without a write. It is a net under the main agent's forgetting, not a
 *   second author.
 *
 * Writing a skill needs no tool at all: dsh's `skill-filesystem` provider
 * watches its roots, so a `SKILL.md` written with an ordinary file tool is
 * discovered without a restart.
 *
 * Everything degrades rather than fails. The catalog provider returns empty
 * text instead of throwing, the review pass is optional (the plugin applies
 * without a subagent service — only the catch-up pass goes quiet), and a
 * broken memory store means "the agent remembers nothing", never "the agent
 * cannot answer".
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: resolves the required ctx.systemPrompt service declaration.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MemoryStore } from './store.ts'
import { MEMORY_RULES, TRUST_NOTE, renderSkillRules } from './prompt.ts'
import { assertReviewSchema, reviewOnce, type ReviewSettings } from './review.ts'
import { KIND_REQUIRES_RATIONALE, MEMORY_KINDS } from './types.ts'

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt']

/** Stable section name; a scoped registration may shadow it by reusing the name. */
const RULES_SECTION = 'memory:rules'
/** Stable context name for the regenerated catalog. */
const CATALOG_CONTEXT = 'memory:catalog'
/**
 * Placement among centrally allocated prompt sections. This sits just after
 * the per-tool guidance blocks (`TOOL_*` spans 1000–3000 in
 * `SECTION_ORDERS`) and before `MCP_SERVERS`, so the rules read as one more
 * piece of tool-usage guidance.
 */
const RULES_ORDER = 3050
/** Placement among runtime contexts; after the policy contexts (110–120). */
const CATALOG_ORDER = 200

const DEFAULT_NUDGE_INTERVAL = 10
const DEFAULT_REVIEW_TIMEOUT_MS = 60_000
const DEFAULT_REVIEW_MAX_TOKENS = 2048

/** Plugin configuration. */
export interface Config {
  /**
   * Memory root. Holds `MEMORY.md` (the catalog, regenerated on every write)
   * and `memories/` (one Markdown file per memory). Relative paths resolve
   * against the process working directory.
   */
  dir?: string
  /**
   * Skill root the standing rules point the model at, and where a reviewed
   * skill is written. Defaults to the project-local `.agents/skills`, which
   * `dsh-skill-filesystem` already scans and watches.
   */
  skillsDir?: string
  /** Tool calls without a write before the catch-up pass runs. 0 disables it. */
  nudgeInterval?: number
  /**
   * Subagent provider for the catch-up pass. Defaults to `spawn`.
   *
   * `fork` looks tempting — the child starts from the parent's completed turns
   * — but it cannot work here: this pass runs at `agent/turn-stopping`, when
   * the turn being reviewed has not been committed yet, so a forked child
   * would not see it. (It also requires the parent loop to still be active,
   * which it is not by then.) The window therefore travels in the prompt, and
   * the child is an ordinary `spawn`.
   */
  reviewBackend?: string
  reviewTimeoutMs?: number
  reviewMaxTokens?: number
}

/** Schemastery configuration for the memory plugin. */
export const Config: z<Config> = z.object({
  dir: z.string().default('.dsh/memory'),
  skillsDir: z.string().default('.agents/skills'),
  nudgeInterval: z.natural().default(DEFAULT_NUDGE_INTERVAL),
  reviewBackend: z.string().default('spawn'),
  reviewTimeoutMs: z.natural().default(DEFAULT_REVIEW_TIMEOUT_MS),
  reviewMaxTokens: z.natural().default(DEFAULT_REVIEW_MAX_TOKENS),
})

/** One-line tool summary the model reads when choosing a tool. */
const REMEMBER_DESCRIPTION = [
  '把一条值得跨会话保留的事实写进长期记忆。',
  '记的是「是什么」和「用户是谁」，不是「怎么做」——做法写成技能。',
  'description 会成为记忆目录里唯一显示的那一行，写成以后能靠它想起这条记忆的样子。',
  'type=feedback 时必须给 why 和 howToApply：一条没有原因和适用场景的纠正，在以后的会话里没法执行。',
].join('')

/** `Error`-safe message text for logs. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the standing rules, the regenerated catalog, the `remember` tool,
 * and — when a subagent service is present — the catch-up pass.
 * @param ctx - registrant context carrying the tool and system-prompt registries.
 * @param config - deployment's memory root, skill root, and review policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const dir = config.dir ?? '.dsh/memory'
  const skillsDir = config.skillsDir ?? '.agents/skills'
  const store = new MemoryStore(dir)

  try {
    store.ensureDirs()
  } catch (error) {
    ctx.logger.warn(`dsh-memory: cannot prepare memory root ${dir}: ${message(error)}`)
  }

  // Byte-stable for a given configuration → cached prefix. Dynamic content
  // lives in the context registration below, so a write invalidates only the
  // tail of the prompt rather than everything after the rules.
  const rules = [MEMORY_RULES, '', renderSkillRules(skillsDir)].join('\n')
  ctx.systemPrompt.section({ name: RULES_SECTION, order: RULES_ORDER, text: rules })

  ctx.systemPrompt.context({
    name: CATALOG_CONTEXT,
    order: CATALOG_ORDER,
    text: () => {
      try {
        return `${store.renderCatalog()}\n\n${TRUST_NOTE}`
      } catch (error) {
        // Assembly must not fail because the memory store is unreadable: an
        // agent with no memories is a degraded agent, not a broken one.
        ctx.logger.warn(`dsh-memory: cannot read catalog at ${dir}: ${message(error)}`)
        return ''
      }
    },
  })

  ctx.tools.register(defineTool({
    name: 'remember',
    description: REMEMBER_DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: '一句话标题。会用来生成文件名。' },
      content: { type: 'string', required: true, description: '记忆正文。' },
      type: {
        type: 'string',
        required: true,
        enum: [...MEMORY_KINDS],
        description: 'user（用户是谁）| feedback（对工作方式的纠正）| project（项目状态）| reference（外部资源指针）。',
      },
      description: { type: 'string', required: true, description: '一行摘要，目录里显示的就是它。' },
      why: { type: 'string', description: '为什么。type=feedback 时必填。' },
      howToApply: { type: 'string', description: '下次怎么用。type=feedback 时必填。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['created', 'reinforced'] },
          path: { type: 'string', required: true },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.action === 'created'
          ? `已记住（${value.path}），目录现有 ${value.total} 条。`
          : `已有记忆覆盖了这条，已就地强化（${value.path}），目录现有 ${value.total} 条。`,
      }],
    },
    execute(args, exec) {
      if (args.content.trim().length === 0) {
        throw new Error('content 不能为空：写一句以后能读懂的话。')
      }
      if (args.description.trim().length === 0) {
        throw new Error('description 不能为空：它是目录里唯一显示的一行，也是以后找回这条记忆的唯一线索。')
      }
      if (KIND_REQUIRES_RATIONALE.includes(args.type) && (args.why === undefined || args.howToApply === undefined)) {
        throw new Error(`type=${args.type} 的记忆必须同时给 why 和 howToApply：没有原因和适用场景的纠正，在以后的会话里没法执行。`)
      }
      const sessionId = exec.agent?.session.id
      try {
        return Promise.resolve(store.remember({
          title: args.title,
          content: args.content,
          kind: args.type,
          description: args.description,
          ...(args.why !== undefined ? { why: args.why } : {}),
          ...(args.howToApply !== undefined ? { howToApply: args.howToApply } : {}),
          ...(sessionId !== undefined ? { sourceSession: sessionId } : {}),
        }))
      } catch (error) {
        // A failed tool call is a failed tool call. It reaches the model as an
        // error it can react to, and never blocks the surrounding turn.
        throw new Error(`记忆写入失败（${dir}）：${message(error)}`)
      }
    },
    presentCall: args => ({ card: 'generic', title: `记住：${args.title}`, kind: 'other', rawInput: args }),
  }))

  const interval = config.nudgeInterval ?? DEFAULT_NUDGE_INTERVAL
  if (interval <= 0) return

  // Optional service: the plugin is fully useful without a subagent backend,
  // and only the catch-up pass goes quiet when one is absent. Declaring
  // `subagents` in `inject` instead would take the standing rules down with it.
  ctx.inject(['subagents'], (scope) => {
    assertReviewSchema()
    const settings: ReviewSettings = {
      interval,
      backend: config.reviewBackend ?? 'fork',
      timeoutMs: config.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      maxTokens: config.reviewMaxTokens ?? DEFAULT_REVIEW_MAX_TOKENS,
      skillsDir,
    }
    // One pass per session at a time; concurrent passes would race the
    // checkpoint and duplicate whatever both of them reviewed.
    const pending = new Map<string, Promise<void>>()

    scope.on('agent/turn-stopping', ({ agent }: { agent: Agent }) => {
      const session = agent.session
      if (pending.has(session.id)) return
      const job = (async () => {
        try {
          // `scope`, not the outer `ctx`: `subagents` is only reachable through
          // the context that declared it in `inject`. Passing the outer context
          // fails at dispatch with "cannot get property subagents without inject".
          const report = await reviewOnce(scope, store, settings, agent)
          if (report !== undefined) {
            ctx.logger.info(`dsh-memory: review pass wrote ${report.memories} memories, ${report.skills} skills — ${report.summary}`)
          }
        } catch (error) {
          // The reviewer is best-effort by construction: whatever it was doing,
          // the user's conversation is already finished and unaffected.
          ctx.logger.warn(`dsh-memory: review pass failed: ${message(error)}`)
        } finally {
          pending.delete(session.id)
        }
      })()
      pending.set(session.id, job)
    })

    scope.on('session/disposed', (session: Session) => {
      pending.delete(session.id)
    })
  })
}
