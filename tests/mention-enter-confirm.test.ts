import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 回归：#157 —— @ 候选菜单打开时按 Enter 曾被"发送消息"分支拦截，
 * 未完成的 @xxx 文本直接发出，Enter 选人分支不可达，只能鼠标点选；
 * Shift+Enter 反而漏进选人分支，占用换行语义。
 * 另覆盖其姊妹 bug：Esc 曾用 setInputFocused(false) 关闭菜单，但输入框
 * 并未真正失焦、onFocus 不会再次触发，导致之后再按 @ 无法唤起候选。
 * 无 React 渲染环境，按仓库惯例对 App.tsx 的按键接线做源码结构断言。
 */

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

describe("mention menu Enter confirm", () => {
  test("composer dispatches to either candidate menu before the Enter-send branch", () => {
    const guardIndex = appSource.indexOf("if (isImeComposition(event)) {");
    const dispatchGuardIndex = appSource.indexOf(
      "if (mentionCandidates.length > 0 || slashMenuOpen) {",
    );
    const dispatchIndex = appSource.indexOf(
      "handleComposerKeyDown(event as unknown as KeyboardEvent<HTMLInputElement>);",
    );
    const sendIndex = appSource.indexOf("sendMessage(event as unknown as FormEvent<HTMLFormElement>)");

    assert.ok(guardIndex > 0, "composer onKeyDown must keep the composition guard");
    assert.ok(
      dispatchGuardIndex > 0,
      "the dispatch guard must cover both menus: mention candidates and the slash menu in every phase (candidates or status line)",
    );
    assert.ok(dispatchGuardIndex > guardIndex, "menu dispatch must come after the composition guard");
    assert.ok(dispatchIndex > dispatchGuardIndex, "menu dispatch must be gated by open candidates of either menu");
    assert.ok(sendIndex > dispatchIndex, "Enter-send must run only when both menus are closed");

    const dispatchBlock = appSource.slice(dispatchIndex, sendIndex);
    assert.ok(dispatchBlock.includes("return;"), "handled menu keys must not fall through to send");
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

  test("Esc dismisses the menu through a dedicated flag, not the focus state", () => {
    const match = appSource.match(/function handleComposerKeyDown\([\s\S]*?\n  \}/);
    assert.ok(match, "handleComposerKeyDown must exist in App.tsx");
    assert.ok(match[0].includes("setMentionDismissed(true)"), "Esc must set the dismissal flag");
    assert.ok(
      !match[0].includes("setInputFocused(false)"),
      "Esc must not clear inputFocused: the textarea keeps DOM focus, so onFocus never refires and the menu could never reopen",
    );
  });

  test("dismissal blocks candidates and clears once the mention draft is gone", () => {
    const memo = appSource.match(/const mentionCandidates = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[/);
    assert.ok(memo, "mentionCandidates memo must exist in App.tsx");
    assert.ok(memo[0].includes("mentionDismissed"), "candidates must respect the dismissal flag");

    const resetEffect = appSource.match(
      /useEffect\(\(\) => \{\s*if \(!mentionDraft\) \{\s*setMentionDismissed\(false\);\s*\}\s*\}, \[mentionDraft\]\);/,
    );
    assert.ok(resetEffect, "dismissal must reset when the mention draft disappears");
  });
});
