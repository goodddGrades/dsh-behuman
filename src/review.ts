/**
 * The background catch-up pass.
 *
 * The main agent is the primary writer — it is present for the whole task and
 * knows how a problem was actually worked around. It also, measurably,
 * forgets. This module is the net under that: a counter of tool calls since
 * the last pass, and a spawned child that reads the window and reports what
 * was missed.
 *
 * Three properties are load-bearing:
 *
 * 1. **The window travels in the prompt.** The child is an ordinary `spawn`
 *    with an empty conversation. `fork` would hand it the conversation for
 *    free, but a forked child only sees *completed* turns — and this pass runs
 *    at `agent/turn-stopping`, before the turn it is reviewing has been
 *    committed. It also requires the parent loop to still be active, which it
 *    is not by then. So the checkpointed window is rendered into the prompt.
 * 2. **The checkpoint advances before the review runs.** If the child dies,
 *    the window is already consumed and nothing is reviewed twice.
 * 3. **The child proposes; `apply.ts` decides.** It runs with no tools and
 *    returns structured data, so every write still goes through the same
 *    validation, dedupe, and catalog regeneration as a `remember` call.
 * @module
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { assertObjectJsonSchema, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { applyReport, type ReviewReport } from './apply.ts'
import { countToolCalls, renderWindow, scanClues } from './clues.ts'
import { renderReviewPrompt } from './prompt.ts'
import type { MemoryStore } from './store.ts'
import { MEMORY_KINDS } from './types.ts'

/**
 * What the reviewer may report. Every field is optional in effect: an empty
 * `memories` and `skills` with a `summary` of "没有" is the expected answer for
 * most passes, and the schema must make that as easy to emit as any other.
 */
const REVIEW_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          type: { type: 'string', enum: [...MEMORY_KINDS] },
          description: { type: 'string' },
          why: { type: 'string' },
          howToApply: { type: 'string' },
        },
        required: ['title', 'content', 'type', 'description'],
      },
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          content: { type: 'string' },
          whenToUse: { type: 'string' },
        },
        required: ['name', 'description', 'content'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['memories', 'skills', 'summary'],
}

/** Reviewer settings the scheduler needs. */
export interface ReviewSettings {
  /** Tool calls since the last pass before one runs. */
  readonly interval: number
  /** Subagent provider name; the window travels in the prompt, so `spawn` is correct here. */
  readonly backend: string
  readonly timeoutMs: number
  readonly maxTokens: number
  /** Skill root, scanned for the inventory and written to on a new proposal. */
  readonly skillsDir: string
}

/** Last consumed sequence per session. Session-keyed so disposal releases it. */
const checkpoints = new WeakMap<Session, number>()

/** `Error`-safe message text. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Names of skill bundles already present, for the reviewer's inventory. */
function listExistingSkills(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .slice(0, 50)
  } catch {
    return []
  }
}

/**
 * Run one review pass for a settled session, if the counter has reached the
 * threshold. Consumes the window before dispatching, so a failed child never
 * causes the same turns to be reviewed twice.
 * @param ctx - context exposing `subagents`.
 * @param store - the memory store.
 * @param settings - reviewer settings.
 * @param agent - the settled parent agent authorizing the delegation.
 * @returns what the pass wrote, or `undefined` when it did not run.
 */
export async function reviewOnce(
  ctx: Context,
  store: MemoryStore,
  settings: ReviewSettings,
  agent: Agent,
): Promise<ReviewReport | undefined> {
  const session = agent.session
  const events = session.snapshotEvents()
  const since = checkpoints.get(session) ?? -1
  const calls = countToolCalls(events, since)
  if (calls < settings.interval) return undefined

  // Advance first: the window is consumed whether or not the child succeeds.
  checkpoints.set(session, session.seq)

  const transcript = renderWindow(events, since)
  const clues = scanClues(events, since).map(clue => `［${clue.tag}］${clue.note}`)
  const prompt = renderReviewPrompt(transcript, clues, listExistingSkills(settings.skillsDir))
  const content: ContentBlock[] = [{ type: 'text', text: prompt }]
  ctx.logger.info(`dsh-memory: dispatching review pass (${calls} tool calls, ${transcript.length} chars)`)

  using callDeadline = deadline(undefined, settings.timeoutMs, 'DSH_MEMORY_REVIEW_TIMEOUT')
  let run
  try {
    run = await ctx.subagents.start(settings.backend, {
      label: 'dsh-memory-review',
      prompt: content,
      parent: agent,
      signal: callDeadline.signal,
      // No tools: the child reports, this module writes. An isolated child
      // cannot touch the workspace, and every write keeps one code path.
      toolFilter: { allow: [] },
      outputSchema: REVIEW_SCHEMA,
      agentOptions: { maxTokens: settings.maxTokens },
    })
  } catch (error) {
    ctx.logger.warn(`dsh-memory: review dispatch failed: ${errorMessage(error)}`)
    return undefined
  }

  try {
    const result: SubagentResult = await run.result
    if (result.stopReason !== 'completed') {
      ctx.logger.warn(`dsh-memory: review ended with ${result.stopReason}`)
      return undefined
    }
    if (result.structured === undefined) {
      ctx.logger.warn('dsh-memory: review finished without a structured report')
      return undefined
    }
    return applyReport(ctx.logger, store, settings, result.structured)
  } catch (error) {
    ctx.logger.warn(`dsh-memory: review failed: ${errorMessage(error)}`)
    return undefined
  } finally {
    try {
      await run.dispose()
    } catch (error) {
      ctx.logger.warn(`dsh-memory: review disposal failed: ${errorMessage(error)}`)
    }
  }
}

/**
 * Validate the reviewer's output schema once, at activation.
 * @param schema - the schema to check.
 */
export function assertReviewSchema(schema: ObjectJsonSchema = REVIEW_SCHEMA): void {
  assertObjectJsonSchema(schema)
}

/** The review output schema, exported for tests. */
export const reviewSchema: ObjectJsonSchema = REVIEW_SCHEMA
