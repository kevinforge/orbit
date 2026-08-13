import type { WorkspacePreset } from "../shared/types.ts";

/** Canonical preset ids — single source of truth, referenced via these constants. */
export const PRESET_IDS = {
  empty: "empty",
  /** 软件开发团队模板：id 与 AGENT_TEAM_TEMPLATES 中的团队 id 对齐，选择该模板即预置整个团队。 */
  softwareDevelopment: "software-development",
} as const;

/**
 * Find the preset whose content matches the given systemPrompt and rules.
 * Both sides are normalized: systemPrompt is trimmed, rules are trimmed and
 * empty strings are removed, then compared by value.
 * Returns the matching preset id, or `null` if no preset matches.
 */
export function matchPreset(
  systemPrompt: string,
  rules: string[],
  presets: WorkspacePreset[],
): string | null {
  const normalizedPrompt = systemPrompt.trim();
  const normalizedRules = rules.map((r) => r.trim()).filter(Boolean);
  for (const preset of presets) {
    const pPrompt = preset.systemPrompt.trim();
    const pRules = preset.rules.map((r) => r.trim()).filter(Boolean);
    if (normalizedPrompt === pPrompt
      && normalizedRules.length === pRules.length
      && normalizedRules.every((r, i) => r === pRules[i])) {
      return preset.id;
    }
  }
  return null;
}

export function getWorkspacePresets(): WorkspacePreset[] {
  return [
    {
      id: PRESET_IDS.empty,
      name: "空白",
      description: "不预置数字员工，创建后可按需添加",
      systemPrompt: "",
      rules: [],
    },
    {
      id: PRESET_IDS.softwareDevelopment,
      name: "软件开发团队",
      description: "预置范同经（梳理需求）、甄架构（设计方案）、蔡一平（编码实现）、田小坑（验证质量）四个数字员工，内置闭环协作流程",
      teamId: "software-development",
      systemPrompt:
        "当前是一个多数字员工协作的会话，在需要其他数字员工完成工作的时候一定要根据规则来指派。用户发出的问题，要做到持续闭环。比如：当甄架构根据需求设计了开发方案应该主动让蔡一平进行开发，蔡一平开发完了之后让甄架构来review代码，有问题再让蔡一平来修复代码，每次改完代码都要让甄架构来做review，直到没有问题再让田小坑测试，有问题继续修复，直到没问题这个需求才闭环。",
      rules: [
        "用户的语言是中文，请使用中文回答用户的问题。",
        "当多个数字员工的工作存在前后依赖时，必须按顺序指派：先仅 @前置数字员工，等待其完成并返回结果后，再在下一条消息中 @后续数字员工；不要在同一条消息中同时 @存在依赖关系的数字员工。无依赖、可并行的任务可以同时指派。",
      ],
      recommended: true,
    },
  ];
}
