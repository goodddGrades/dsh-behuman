/**
 * The durable-memory vocabulary shared by the store, the catalog, and the
 * model-facing tool.
 * @module
 */

/**
 * Durable memory kinds. The taxonomy answers "what is this?", never "how
 * important is it?" — importance is a judgement the model would self-report,
 * and self-reported importance is exactly what a memory store must not trust.
 */
export type MemoryKind = 'user' | 'feedback' | 'project' | 'reference'

/** Runtime list of {@link MemoryKind}, for schema enums and validation. */
export const MEMORY_KINDS = ['user', 'feedback', 'project', 'reference'] as const

/**
 * The two kinds whose value is an instruction about how to work, and which
 * therefore must carry a reason and an application rule — a correction without
 * "why" and "when to apply it" is not actionable in a later session.
 */
export const KIND_REQUIRES_RATIONALE: readonly MemoryKind[] = ['feedback']

/** One stored memory: parsed frontmatter plus the path it lives at. */
export interface MemoryEntry {
  /** Slug used as the file name, without the `.md` suffix. */
  readonly name: string
  /** Human-readable title, shown as the catalog link text. */
  readonly title: string
  /**
   * One-line summary. The catalog shows nothing else about a memory, so this
   * is the sole retrieval signal the model has when deciding whether to open
   * the file.
   */
  readonly description: string
  readonly kind: MemoryKind
  /** `YYYY-MM-DD` the memory was first written; preserved across reinforcement. */
  readonly created: string
  /** Session that first produced the memory, when the caller had one. */
  readonly sourceSession?: string
  /** Path relative to the memory root, e.g. `memories/foo.md`. */
  readonly path: string
}

/** What a caller asks the store to persist. */
export interface RememberInput {
  readonly title: string
  readonly content: string
  readonly kind: MemoryKind
  readonly description: string
  readonly why?: string
  readonly howToApply?: string
  readonly sourceSession?: string
}

/**
 * Result of one write. `reinforced` means an existing memory already covered
 * this fact and was rewritten in place — repetition is evidence a memory
 * matters, so it strengthens rather than duplicates.
 */
export interface RememberOutcome {
  readonly action: 'created' | 'reinforced'
  /** Path relative to the memory root. */
  readonly path: string
  /** Catalog size after the write. */
  readonly total: number
}
