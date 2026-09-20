/**
 * Materializing a reviewed skill as a `SKILL.md` bundle.
 *
 * No tool is involved: `dsh-skill-filesystem` watches its roots, so a file
 * written here is discovered the same way a hand-authored skill is. That also
 * means this module is the only gate between a model's proposal and the skill
 * library, so the name checks below are the difference between a library and a
 * junk drawer.
 * @module
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { slugify } from './store.ts'

/**
 * Names that describe one incident rather than a class of work. A skill named
 * after today's task can never be found by tomorrow's, which is exactly how a
 * library turns into a pile of one-shot files.
 */
const SESSION_ARTIFACT = /(?:^|-)(?:fix|debug|hotfix|revert|audit|patch|issue|bug|ticket|pr)(?:-|$)/i

/**
 * A name carrying a number that identifies one incident: a bare PR/issue
 * number, or a version tag riding on a segment (`retry-v2`, `pr-1234`,
 * `issue-42`). Matched per hyphen-delimited segment so ordinary names that
 * merely contain digits — `oauth2-flow`, `es2015-modules`, `http2-client` —
 * stay acceptable.
 */
const INCIDENT_NUMBER = /(?:^|-)v?\d/i

/** Longest skill name accepted; deep directory names get unwieldy past this. */
const MAX_NAME_LENGTH = 48

/** One reviewed skill proposal. */
export interface SkillProposal {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly whenToUse?: string
}

/** Why a proposal was rejected, or `undefined` when it is acceptable. */
export function rejectSkillName(name: string): string | undefined {
  const slug = slugify(name)
  if (slug.length === 0) return '名字是空的'
  if (slug.length > MAX_NAME_LENGTH) return `名字太长（${slug.length} > ${MAX_NAME_LENGTH}）`
  if (SESSION_ARTIFACT.test(slug)) return '名字指向一次具体的事故（fix-/debug-/audit-/issue 等），不是一类任务'
  if (INCIDENT_NUMBER.test(slug)) return '名字里带着某一次事件的编号（PR 号、issue 号、版本号）'
  return undefined
}

/** Render one `SKILL.md`, frontmatter first, in the shape the filesystem provider parses. */
function renderSkill(proposal: SkillProposal, name: string): string {
  const lines = ['---', `name: ${name}`, `description: ${proposal.description.trim()}`]
  if (proposal.whenToUse !== undefined && proposal.whenToUse.trim().length > 0) {
    lines.push(`whenToUse: ${proposal.whenToUse.trim()}`)
  }
  lines.push('---', '', proposal.content.trim(), '')
  return lines.join('\n')
}

/** Outcome of one write attempt. */
export type SkillWriteResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Write a new skill bundle, refusing anything that would overwrite an existing
 * one. Updates to loaded skills stay with the main agent: it is the component
 * that actually used the skill and knows what was wrong with it, and a
 * reviewer that only saw the skill's one-line description has no business
 * rewriting its body.
 * @param skillsDir - skill root to write into.
 * @param proposal - the reviewed proposal.
 * @returns the written path, or why nothing was written.
 */
export function writeSkill(skillsDir: string, proposal: SkillProposal): SkillWriteResult {
  const rejected = rejectSkillName(proposal.name)
  if (rejected !== undefined) return { ok: false, reason: rejected }
  if (proposal.content.trim().length === 0) return { ok: false, reason: '技能正文是空的' }

  const name = slugify(proposal.name)
  const bundle = join(skillsDir, name)
  if (existsSync(bundle)) return { ok: false, reason: `已有同名技能 ${name}，交给主 agent 去更新更好` }

  try {
    mkdirSync(bundle, { recursive: true })
    const path = join(bundle, 'SKILL.md')
    writeFileSync(path, renderSkill(proposal, name), 'utf8')
    return { ok: true, path }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
