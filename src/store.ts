/**
 * File-backed memory store: one Markdown file per memory, plus a catalog that
 * is always regenerated from those files.
 *
 * Two invariants drive the whole module:
 *
 * 1. **The catalog is derived, never authored.** Every write rebuilds
 *    `MEMORY.md` from `memories/`. A memory whose file exists but whose catalog
 *    line does not is invisible forever, and the model is the wrong component
 *    to keep two things in sync — it reliably judges "this is worth keeping"
 *    and unreliably remembers "now go register it".
 * 2. **Nothing here throws into a caller that cannot recover.** Validation
 *    problems are the model's to fix and are reported as errors; filesystem
 *    failures are reported the same way, because a failed tool call is a
 *    failed tool call and never blocks the conversation.
 *
 * Synchronous filesystem calls are deliberate: the catalog is read from a
 * synchronous prompt-context provider on every assembly, and each memory is a
 * few hundred bytes.
 * @module
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryKind,
  type RememberInput,
  type RememberOutcome,
} from './types.ts'

/**
 * Lexical overlap at which a new memory is treated as re-confirming an
 * existing one rather than adding a second copy. The comparison is bigram
 * containment, which needs no word segmentation for Chinese — the property
 * that makes it usable here without a tokenizer dependency.
 */
const REINFORCE_THRESHOLD = 0.82

/** Longest slug produced from a title; keeps file names well inside every platform's limit. */
const MAX_SLUG_LENGTH = 60

/** Subdirectory holding the memory bodies, and the catalog file name beside it. */
const MEMORIES_DIR = 'memories'
const CATALOG_FILE = 'MEMORY.md'

/** Whether `value` is one of the four durable kinds. */
export function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value)
}

/**
 * Derive a file-name slug from a title. Anything that is not a letter or a
 * digit becomes a separator, which also removes path separators, `.` and `..`,
 * and every other character that could escape the memories directory.
 * @param title - the model-supplied memory title.
 * @returns a non-empty slug, truncated to {@link MAX_SLUG_LENGTH}.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'memory'
}

/**
 * Character bigrams of a string, whitespace removed. Two-character windows are
 * the smallest unit that still carries word order, and they sidestep the fact
 * that Chinese text has no spaces to split on.
 */
function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/gu, '')
  const grams = new Set<string>()
  for (let i = 0; i < normalized.length - 1; i++) grams.add(normalized.slice(i, i + 2))
  if (grams.size === 0 && normalized.length > 0) grams.add(normalized)
  return grams
}

/**
 * Fraction of `probe`'s bigrams that also occur in `candidate` — asymmetric
 * containment, not Jaccard: a short restatement of a long memory should score
 * high, while a long memory containing a short phrase should not.
 * @param probe - the incoming text.
 * @param candidate - the existing text it is compared against.
 * @returns containment in `[0, 1]`; 0 when `probe` has no comparable grams.
 */
export function bigramOverlap(probe: string, candidate: string): number {
  const left = bigrams(probe)
  if (left.size === 0) return 0
  const right = bigrams(candidate)
  let hit = 0
  for (const gram of left) if (right.has(gram)) hit++
  return hit / left.size
}

/** Strip one layer of matching single or double quotes from a frontmatter value. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1)
  }
  return value
}

/**
 * Split a memory file into its frontmatter fields and body. Only the flat
 * `key: value` subset this module writes is understood; anything else is left
 * in the body rather than guessed at.
 * @param raw - the whole file.
 * @returns the parsed fields and the remaining body.
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw
  if (!text.startsWith('---')) return { fields: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key.length > 0) fields[key] = unquote(line.slice(at + 1).trim())
  }
  return { fields, body: text.slice(end + 4).replace(/^\r?\n/, '') }
}

/** Render one memory file, frontmatter first. */
function renderMemoryFile(slug: string, input: RememberInput, created: string, today: string): string {
  const lines = [
    '---',
    `name: ${slug}`,
    `title: ${input.title}`,
    `description: ${input.description}`,
    `type: ${input.kind}`,
    `created: ${created}`,
  ]
  if (input.sourceSession !== undefined && input.sourceSession.length > 0) {
    lines.push(`source_session: ${input.sourceSession}`)
  }
  if (created !== today) lines.push(`updated: ${today}`)
  lines.push('---', '', input.content.trim(), '')
  if (input.why !== undefined && input.why.trim().length > 0) {
    lines.push(`**Why:** ${input.why.trim()}`, '')
  }
  if (input.howToApply !== undefined && input.howToApply.trim().length > 0) {
    lines.push(`**How to apply:** ${input.howToApply.trim()}`, '')
  }
  return lines.join('\n')
}

/** Today as `YYYY-MM-DD`. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * One memory root on disk. Construct once per plugin activation; every method
 * re-reads the directory, so external edits (a person editing a file by hand)
 * take effect without a restart.
 */
export class MemoryStore {
  /** Absolute path of the memory root. */
  readonly root: string
  private readonly memoriesDir: string
  private readonly catalogPath: string

  /** @param root - directory holding `MEMORY.md` and `memories/`. */
  constructor(root: string) {
    this.root = root
    this.memoriesDir = join(root, MEMORIES_DIR)
    this.catalogPath = join(root, CATALOG_FILE)
  }

  /** Create the memory root and its `memories/` subdirectory. */
  ensureDirs(): void {
    mkdirSync(this.memoriesDir, { recursive: true })
  }

  /**
   * Parse every readable memory file, newest first. Unreadable or malformed
   * files are skipped rather than failing the read: one bad file must not hide
   * the rest of the store.
   * @returns the entries currently on disk.
   */
  list(): MemoryEntry[] {
    let files: string[]
    try {
      files = readdirSync(this.memoriesDir)
    } catch {
      return []
    }
    const entries: MemoryEntry[] = []
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      let raw: string
      try {
        raw = readFileSync(join(this.memoriesDir, file), 'utf8')
      } catch {
        continue
      }
      const { fields } = parseFrontmatter(raw)
      const kind = fields['type']
      if (kind === undefined || !isMemoryKind(kind)) continue
      const slug = fields['name'] ?? file.replace(/\.md$/u, '')
      entries.push({
        name: slug,
        title: fields['title'] ?? slug,
        description: fields['description'] ?? '',
        kind,
        created: fields['created'] ?? '',
        ...(fields['source_session'] !== undefined ? { sourceSession: fields['source_session'] } : {}),
        path: `${MEMORIES_DIR}/${file}`,
      })
    }
    entries.sort((a, b) => (a.created === b.created ? a.name.localeCompare(b.name) : b.created.localeCompare(a.created)))
    return entries
  }

  /**
   * The catalog text the model sees. One line per memory — the file name for
   * the model to open, and the description it decides with.
   * @returns Markdown for the dynamic prompt context.
   */
  renderCatalog(): string {
    const entries = this.list()
    if (entries.length === 0) return '（还没有任何记忆。用 remember 工具记录第一条。）'
    return entries.map(e => `- [${e.title}](${e.path}) — ${e.description}`).join('\n')
  }

  /** Regenerate `MEMORY.md` from the files on disk. */
  rebuildCatalog(): void {
    this.ensureDirs()
    const body = `# 记忆目录\n\n${this.renderCatalog()}\n`
    this.writeAtomic(this.catalogPath, body)
  }

  /**
   * Persist one memory, reinforcing an existing one when the incoming text
   * already covers it.
   * @param input - the model-supplied memory.
   * @returns what happened, and the catalog size afterwards.
   * @throws when the filesystem rejects the write; callers surface that to the model.
   */
  remember(input: RememberInput): RememberOutcome {
    this.ensureDirs()
    const existing = this.list()
    const probe = `${input.title} ${input.description}`

    let best: { entry: MemoryEntry; score: number } | undefined
    for (const entry of existing) {
      const score = bigramOverlap(probe, `${entry.title} ${entry.description}`)
      if (best === undefined || score > best.score) best = { entry, score }
    }

    if (best !== undefined && best.score >= REINFORCE_THRESHOLD) {
      // Repetition is evidence, not noise: keep the original creation date and
      // rewrite the body, so the memory strengthens instead of forking.
      const file = best.entry.path.slice(MEMORIES_DIR.length + 1)
      const rewritten: RememberInput = { ...input, title: best.entry.title }
      this.writeAtomic(
        join(this.memoriesDir, file),
        renderMemoryFile(best.entry.name, rewritten, best.entry.created, today()),
      )
      this.rebuildCatalog()
      return { action: 'reinforced', path: best.entry.path, total: this.list().length }
    }

    const slug = this.uniqueSlug(slugify(input.title), existing)
    const file = `${slug}.md`
    this.writeAtomic(join(this.memoriesDir, file), renderMemoryFile(slug, input, today(), today()))
    this.rebuildCatalog()
    return { action: 'created', path: `${MEMORIES_DIR}/${file}`, total: this.list().length }
  }

  /** A slug not already taken by a different memory. */
  private uniqueSlug(base: string, existing: readonly MemoryEntry[]): string {
    const taken = new Set(existing.map(e => e.name))
    if (!taken.has(base)) return base
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`
      if (!taken.has(candidate)) return candidate
    }
    return `${base}-${randomUUID().slice(0, 8)}`
  }

  /**
   * Write via a temporary file in the same directory, then rename. A crash
   * mid-write leaves the previous contents intact rather than a half file.
   */
  private writeAtomic(path: string, contents: string): void {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, contents, 'utf8')
      renameSync(temp, path)
    } catch (error) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // Cleanup is best-effort; the original error is the one that matters.
      }
      throw error
    }
  }
}
