import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 回归：#157 —— @ 候选菜单打开时按 Enter 曾被"发送消息"分支拦截，
 * 未完成的 @xxx 文本直接发出，Enter 选人分支不可达，只能鼠标点选；
 * Shift+Enter 反而漏进选人分支，占用换行语义。
 * 无 React 渲染环境，按仓库惯例对 App.tsx 的按键接线做源码结构断言。
 */

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

describe("mention menu Enter confirm", () => {
  test("composer dispatches to the mention menu before the Enter-send branch", () => {
    const guardIndex = appSource.indexOf("if (isImeComposition(event)) {");
    const mentionOpenIndex = appSource.indexOf("if (mentionCandidates.length > 0) {");
    const dispatchIndex = appSource.indexOf(
      "handleComposerKeyDown(event as unknown as KeyboardEvent<HTMLInputElement>);",
    );
    const sendIndex = appSource.indexOf("sendMessage(event as unknown as FormEvent<HTMLFormElement>)");

    assert.ok(guardIndex > 0, "composer onKeyDown must keep the composition guard");
    assert.ok(mentionOpenIndex > guardIndex, "mention dispatch must come after the composition guard");
    assert.ok(dispatchIndex > mentionOpenIndex, "mention dispatch must be guarded by open candidates");
    assert.ok(sendIndex > dispatchIndex, "Enter-send must run only when the mention menu is closed");

    const dispatchBlock = appSource.slice(dispatchIndex, sendIndex);
    assert.ok(dispatchBlock.includes("return;"), "handled mention keys must not fall through to send");
  });

  test("menu-closed Enter still sends; the send condition stays shift-guarded", () => {
    const sendIndex = appSource.indexOf("sendMessage(event as unknown as FormEvent<HTMLFormElement>)");
    const sendCondition = appSource.slice(sendIndex - 300, sendIndex);
    assert.ok(
      sendCondition.includes('event.key === "Enter" && !event.shiftKey'),
      "plain Enter sends only when no mention candidate is open",
    );
  });

  test("Enter confirm in the mention menu keeps Shift+Enter as a newline", () => {
    const match = appSource.match(/function handleComposerKeyDown\([\s\S]*?\n  \}/);
    assert.ok(match, "handleComposerKeyDown must exist in App.tsx");
    const handler = match[0];
    assert.ok(
      handler.includes('event.key === "Enter" && !event.shiftKey'),
      "Shift+Enter must not be treated as mention confirmation",
    );
    assert.ok(
      handler.indexOf("chooseMention") > handler.indexOf('event.key === "Enter" && !event.shiftKey'),
      "the shift-guarded Enter branch must drive chooseMention",
    );
  });
});
