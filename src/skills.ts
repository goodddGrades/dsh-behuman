/**
 * Materializing a reviewed skill as a `SKILL.md` bundle.
 *
 * No tool is involved: `dsh-skill-filesystem` watches its roots, so a file
 * written here is discovered the same way a hand-authored skill is. That also
 * means this module is the only gate between a model's proposal and the skill
 * library, so the name checks and the ownership check below are the difference
 * between a library and a junk drawer.
 *
 * **Ownership.** Every skill this plugin writes carries a marker in its
 * frontmatter `metadata`. The marker is what lets the plugin tell its own
 * artifacts from yours: it will rewrite one of its own, and will never touch a
 * skill you wrote by hand. It also means you can delete an auto-written skill
 * without wondering whether something depends on it.
 * @module
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { slugify } from './store.ts'

/**
 * Marker written into a skill's frontmatter `metadata`, identifying it as
 * written by this plugin rather than by hand. Lives under `metadata` because
 * that is the field dsh carries through for arbitrary caller data — a
 * top-level key would be dropped by the skill provider.
 */
export const SKILL_MARKER_KEY = 'generated-by'
export const SKILL_MARKER_VALUE = 'dsh-behuman'

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

/** The frontmatter block of a `SKILL.md`, or `undefined` when it has none. */
function frontmatterOf(raw: string): string | undefined {
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw
  if (!text.startsWith('---')) return undefined
  const end = text.indexOf('\n---', 3)
  return end === -1 ? undefined : text.slice(3, end)
}

/**
 * Read one key out of the frontmatter `metadata` map.
 *
 * Deliberately a scan of the indented block rather than a YAML parse: this
 * module owns the format it writes, and a substring test over the whole
 * frontmatter would happily match a marker quoted inside a description.
 * @param frontmatter - the frontmatter block, without its `---` fences.
 * @param key - the metadata key to read.
 * @returns the value, or `undefined` when absent.
 */
function metadataValue(frontmatter: string, key: string): string | undefined {
  let inMetadata = false
  for (const line of frontmatter.split(/\r?\n/)) {
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true
      continue
    }
    if (!inMetadata) continue
    // A top-level key ends the metadata block.
    if (/^\S/.test(line)) return undefined
    const at = line.indexOf(':')
    if (at === -1) continue
    if (line.slice(0, at).trim() !== key) continue
    const value = line.slice(at + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1)
    }
    return value
  }
  return undefined
}

/**
 * Whether the skill bundle at `bundleDir` was written by this plugin.
 * @param bundleDir - the `<name>/` directory holding `SKILL.md`.
 * @returns true when the plugin's marker is present.
 */
export function isOwnSkill(bundleDir: string): boolean {
  let raw: string
  try {
    raw = readFileSync(join(bundleDir, 'SKILL.md'), 'utf8')
  } catch {
    return false
  }
  const frontmatter = frontmatterOf(raw)
  if (frontmatter === undefined) return false
  return metadataValue(frontmatter, SKILL_MARKER_KEY) === SKILL_MARKER_VALUE
}

/** Render one `SKILL.md`, frontmatter first, in the shape the filesystem provider parses. */
function renderSkill(proposal: SkillProposal, name: string): string {
  const lines = ['---', `name: ${name}`, `description: ${proposal.description.trim()}`]
  if (proposal.whenToUse !== undefined && proposal.whenToUse.trim().length > 0) {
    lines.push(`whenToUse: ${proposal.whenToUse.trim()}`)
  }
  lines.push('metadata:', `  ${SKILL_MARKER_KEY}: ${SKILL_MARKER_VALUE}`)
  lines.push('---', '', proposal.content.trim(), '')
  return lines.join('\n')
}

/** Outcome of one write attempt. */
export type SkillWriteResult =
  | { readonly ok: true; readonly path: string; readonly action: 'created' | 'updated' }
  | { readonly ok: false; readonly reason: string }

/**
 * Write a skill bundle, refusing to touch anything a person wrote.
 *
 * Three outcomes, decided by who owns the name:
 *
 * - **Name is free** → create it, marked as ours.
 * - **Name is taken by one of ours** → rewrite it. An earlier review wrote it
 *   from a smaller window; this one has more to go on.
 * - **Name is taken by a hand-written skill** → refuse. The person who wrote
 *   it knows something this plugin does not.
 *
 * @param skillsDir - skill root to write into.
 * @param proposal - the reviewed proposal.
 * @returns what happened, or why nothing was written.
 */
export function writeSkill(skillsDir: string, proposal: SkillProposal): SkillWriteResult {
  const rejected = rejectSkillName(proposal.name)
  if (rejected !== undefined) return { ok: false, reason: rejected }
  if (proposal.content.trim().length === 0) return { ok: false, reason: '技能正文是空的' }

  const name = slugify(proposal.name)
  const bundle = join(skillsDir, name)
  const existing = existsSync(bundle)
  if (existing && !isOwnSkill(bundle)) {
    return { ok: false, reason: `已有同名技能 ${name}，但它是手写的，不覆盖` }
  }

  try {
    mkdirSync(bundle, { recursive: true })
    const path = join(bundle, 'SKILL.md')
    writeFileSync(path, renderSkill(proposal, name), 'utf8')
    return { ok: true, path, action: existing ? 'updated' : 'created' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
