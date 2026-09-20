/**
 * Turning one reviewer report into writes.
 *
 * The reviewer proposes; this module decides. Every entry goes through the
 * same gate as a model-invoked `remember` call — the review path gets no
 * shortcut, so a bad proposal can never land by a route the interactive path
 * would have rejected.
 *
 * Kept free of the dispatch machinery (and of `using`) so the whole write path
 * is testable without a subagent service.
 * @module
 */

import { writeSkill, type SkillProposal } from './skills.ts'
import type { MemoryStore } from './store.ts'
import { MEMORY_KINDS, type MemoryKind } from './types.ts'

/** What one review dispatch reported back. */
export interface ReviewReport {
  readonly memories: number
  readonly skills: number
  readonly summary: string
}

/** The logging surface this module needs; `ctx.logger` satisfies it. */
export interface Reporter {
  info(message: string): void
  warn(message: string): void
}

/** Reviewer settings the write path needs. */
export interface ApplySettings {
  /** Skill root a new proposal is written into. */
  readonly skillsDir: string
}

/** Narrow one raw memory entry, or `undefined` when it cannot be trusted. */
function toMemoryEntry(raw: unknown): {
  title: string
  content: string
  description: string
  kind: MemoryKind
  why?: string
  howToApply?: string
} | undefined {
  const item = raw as Partial<Record<'title' | 'content' | 'type' | 'description' | 'why' | 'howToApply', unknown>>
  if (typeof item.title !== 'string' || typeof item.content !== 'string' || typeof item.description !== 'string') {
    return undefined
  }
  const kind = typeof item.type === 'string' ? item.type : ''
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) return undefined
  return {
    title: item.title,
    content: item.content,
    description: item.description,
    kind: kind as MemoryKind,
    ...(typeof item.why === 'string' ? { why: item.why } : {}),
    ...(typeof item.howToApply === 'string' ? { howToApply: item.howToApply } : {}),
  }
}

/** Narrow one raw skill entry, or `undefined` when it cannot be trusted. */
function toSkillProposal(raw: unknown): SkillProposal | undefined {
  const item = raw as Partial<Record<'name' | 'description' | 'content' | 'whenToUse', unknown>>
  if (typeof item.name !== 'string' || typeof item.description !== 'string' || typeof item.content !== 'string') {
    return undefined
  }
  return {
    name: item.name,
    description: item.description,
    content: item.content,
    ...(typeof item.whenToUse === 'string' ? { whenToUse: item.whenToUse } : {}),
  }
}

/**
 * Persist one reviewer report.
 *
 * A malformed entry is skipped, not fatal: the reviewer is a model, and one
 * unusable proposal must not cost the whole pass. A rejected skill name is
 * logged with its reason — that reason is the only signal that the naming
 * rules are doing anything.
 *
 * @param logger - where skips and rejections are reported.
 * @param store - the memory store.
 * @param settings - the skill root.
 * @param structured - the child's structured report, already JSON-validated by the registry.
 * @returns what was actually written.
 */
export function applyReport(
  logger: Reporter,
  store: MemoryStore,
  settings: ApplySettings,
  structured: unknown,
): ReviewReport {
  const report = structured as { memories?: unknown; skills?: unknown; summary?: unknown }
  const summary = typeof report.summary === 'string' ? report.summary : ''
  let memories = 0
  let skills = 0

  if (Array.isArray(report.memories)) {
    for (const raw of report.memories) {
      const entry = toMemoryEntry(raw)
      if (entry === undefined) {
        logger.warn('dsh-memory: skipped a malformed memory proposal')
        continue
      }
      try {
        store.remember(entry)
        memories++
      } catch (error) {
        logger.warn(`dsh-memory: review memory write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (Array.isArray(report.skills)) {
    for (const raw of report.skills) {
      const proposal = toSkillProposal(raw)
      if (proposal === undefined) {
        logger.warn('dsh-memory: skipped a malformed skill proposal')
        continue
      }
      const result = writeSkill(settings.skillsDir, proposal)
      if (result.ok) {
        skills++
        logger.info(`dsh-memory: skill ${result.action} — ${proposal.name}`)
      } else {
        logger.info(`dsh-memory: skill not written (${proposal.name}): ${result.reason}`)
      }
    }
  }

  return { memories, skills, summary }
}
