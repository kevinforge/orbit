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
      description: "预置范同经（梳理需求）、甄架构（设计方案）、蔡一平（编码实现）、田小坑（验证质量）四个数字员工",
      teamId: "software-development",
      systemPrompt: "",
      rules: [
        "用户的语言是中文，请使用中文回答用户的问题。",
      ],
      recommended: true,
    },
  ];
}
