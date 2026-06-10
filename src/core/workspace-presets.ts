import type { WorkspacePreset } from "../shared/types.ts";

/** Canonical preset ids — single source of truth, referenced via these constants. */
export const PRESET_IDS = {
  empty: "empty",
  multiAgentCollaboration: "multi-agent-collaboration",
} as const;

export function getWorkspacePresets(): WorkspacePreset[] {
  return [
    {
      id: PRESET_IDS.empty,
      name: "空白工作区",
      description: "不预设任何提示词和规则",
      systemPrompt: "",
      rules: [],
    },
    {
      id: PRESET_IDS.multiAgentCollaboration,
      name: "多数字员工协作",
      description: "适用于多数字员工协作开发场景，内置闭环协作流程和中文回复规则",
      systemPrompt:
        "当前是一个多数字员工协作的会话，在需要其他数字员工完成工作的时候一定要根据规则来指派。用户发出的问题，要做到持续闭环。比如：当架构师根据需求设计了开发方案应该主动让开发人员进行开发，开发人员开发完了之后让架构师来review代码，有问题再让开发人员来修复代码，每次改完代码都要让架构师来做review，直到没有问题再让测试人员测试，有问题继续修复，直到没问题这个需求才闭环。",
      rules: ["用户的语言是中文，请使用中文回答用户的问题。"],
      recommended: true,
    },
  ];
}
