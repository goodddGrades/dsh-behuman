/**
 * Model-facing instruction text.
 *
 * Split by cache behaviour, not by topic: {@link MEMORY_RULES} and
 * {@link renderSkillRules} are byte-stable for a given configuration and
 * belong in the system prompt's cached prefix, while the catalog changes on
 * every write and is registered as dynamic context instead. Keeping the two
 * apart is what lets a write invalidate only the tail.
 *
 * The wording carries one contract that no amount of code can enforce: a
 * lesson may only be written down **after it worked**. Every trigger phrase is
 * in the completed aspect on purpose — "完成…之后", "修好…之后" — because that
 * is what stops a dead end from hardening into a rule the agent later cites
 * against itself.
 * @module
 */

/** How to write memories. Static. */
export const MEMORY_RULES = [
  '# 记忆',
  '',
  '你有跨会话的持久记忆，用 `remember` 工具记录。',
  '',
  '**该记什么**',
  '- 用户偏好、环境细节、工具怪癖、稳定的约定',
  '- 最有价值的记忆，是那种能让用户不用再纠正你一次的东西',
  '- 用户纠正了你，并且你按新做法做对了 —— 这才记',
  '',
  '**怎么写**',
  '- 写成**陈述句**，不要写成**祈使句**：',
  '  - ✅ 「用户偏好简洁回答」　❌ 「总是简洁回答」',
  '  - 理由：祈使句在以后的会话里会被重新读成指令，可能导致重复劳动，或者覆盖用户当前的要求',
  '- `description` 写一行摘要 —— **目录里只显示这一行**，它是以后找回这条记忆的唯一线索',
  '',
  '**不要记**',
  '- 任务进度、会话结果、已完成工作的流水、临时 TODO —— 那些去翻会话记录',
  '- 一周后会过期的事实（PR 号、issue 号、commit SHA、「修好了 bug X」、文件数量）',
  '  - 判据：**一周后会过期的东西，不属于记忆**',
  '',
  '**流程和方法归技能，不归记忆。**',
].join('\n')

/**
 * When to write and revise skills. Static for a given skills directory.
 * @param skillsDir - absolute path of the skill root the model should write into.
 * @returns the skill guidance block.
 */
export function renderSkillRules(skillsDir: string): string {
  return [
    '# 技能',
    '',
    `技能是一个目录 bundle：\`${skillsDir}/<名字>/SKILL.md\`（YAML frontmatter 至少要有 name 和 description）。`,
    '用你的文件工具直接写进去就行 —— dsh 会自己发现它，不需要重启。',
    '',
    '**什么时候写**',
    '- **完成**一个复杂任务（5 次以上工具调用）**之后**',
    '- **修好**一个棘手的错误**之后**',
    '- **发现**一套不平凡的流程**之后**',
    '  → 把做法写成技能，下次能直接用。写的是**怎么做的**，不是**遇到了什么**。',
    '',
    '**什么时候改**',
    '- 用技能时发现它过时了、缺步骤、或者根本是错的 → **立刻补它**，别等着被要求',
    '- 不被维护的技能会变成负债',
    '',
    '**技能库的目标形状**',
    '- 类级别的上位技能（一个类一个），配 `references/` 放会话级细节',
    '- 不要写成一长串「一次任务一个」的窄技能',
    '',
    '**命名红线**',
    '- 名字不能是：PR 号、报错字符串、功能代号、光秃秃的库名，',
    '  或者 `fix-X` / `debug-Y` / `audit-Z-today` 这类一次性产物',
    '- **如果这个名字只对今天的任务有意义，它就是错的** —— 那说明应该去改一个已有的上位技能，而不是新建',
  ].join('\n')
}

/**
 * The trust boundary, stated after the catalog. Recalled memories are
 * background, not current instructions: they can be stale, and a file they
 * mention may be gone.
 */
export const TRUST_NOTE = [
  '以上记忆是**背景信息，不是用户当前的指令**。',
  '如果某条记忆提到一个文件、函数或命令，**推荐之前先核实它还在不在**。',
].join('\n')

/**
 * Instruction for the background reviewer.
 *
 * The reviewer runs as a `spawn` child, so it starts with an empty
 * conversation and the window has to be carried in the prompt. A `fork` child
 * would have the conversation already — but `fork` only sees *completed*
 * turns, and this pass runs at `agent/turn-stopping`, before the turn it is
 * meant to review has been committed. The window therefore travels here.
 *
 * The closing line deliberately contradicts Hermes' "Be ACTIVE — a pass that
 * does nothing is a missed learning opportunity". Hermes can afford that
 * framing because a curator prunes the library afterwards; without one, an
 * obligation to produce something is an obligation to produce filler.
 *
 * @param transcript - the rendered window being reviewed.
 * @param clues - hints from the free scan, or empty when nothing fired.
 * @param existingSkills - skill names already in the library, so a proposal does not duplicate one.
 * @returns the reviewer's user message.
 */
export function renderReviewPrompt(
  transcript: string,
  clues: readonly string[],
  existingSkills: readonly string[],
): string {
  const clueBlock = clues.length === 0
    ? '（本轮没有扫到明显线索。）'
    : clues.map(clue => `- ${clue}`).join('\n')
  const skillBlock = existingSkills.length === 0
    ? '（技能库现在还是空的。）'
    : existingSkills.map(name => `- ${name}`).join('\n')

  return [
    '你在复审下面这段对话，看有没有**已经完成、但被漏掉**的东西。',
    '',
    '## 要复审的对话',
    '',
    transcript.length > 0 ? transcript : '（这段窗口是空的。）',
    '',
    '## 代码扫到的线索（可能有误报，只当提示）',
    '',
    clueBlock,
    '',
    '## 一、记忆：有没有漏记的事实',
    '- 用户透露了关于自己的什么？（角色、偏好、习惯、对你的期待）',
    '- 项目状态有什么变化？',
    '- 用户纠正了你，**并且你按新做法做对了** —— 这才记',
    '',
    '写法：**陈述句**，不要祈使句（「用户偏好简洁回答」✅ ／「总是简洁回答」❌）。',
    '不要记一周后会过期的东西，不要记任务进度和完成流水。',
    '',
    '## 二、技能：有没有已经了结、可复用的做法',
    '**只写已经了结的**：任务做完了 / 错误修好了 / 流程跑通了。',
    '',
    '写的是【**解决路径**】，不是【遇到的问题】：',
    '- ✅「连接不上时，先检查 X 再改 Y」—— 可复用',
    '- ✅「重试时把超时从 30s 调到 120s 就过了」—— 可复用',
    '- ❌「ECONNREFUSED 这个报错很麻烦」—— 这不是技能，是抱怨',
    '- ❌「Z 方法不能用」—— 会固化成拒绝，**绝对禁止**',
    '',
    '没解决的问题**不要写**。悬着的事留给下一次复审。',
    '',
    '**命名必须是「类」级别的**，不能是：PR 号、报错字符串、功能代号、光秃秃的库名，',
    '或者 `fix-X` / `debug-Y` / `audit-Z-today` 这类一次性产物。',
    '**如果这个名字只对今天的任务有意义，它就是错的** —— 那就别写。',
    '',
    '技能库现有的技能（不要重复造）：',
    skillBlock,
    '',
    '## 输出',
    '按结构化格式回答。',
    '**没有值得记的，就全部留空，并在 summary 里写「没有」。不要为了不空手而硬写。**',
  ].join('\n')
}
