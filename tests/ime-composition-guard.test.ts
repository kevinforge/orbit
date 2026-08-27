import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isImeComposition } from "../src/ui/App.tsx";

/**
 * macOS 中文输入法组合（IME composition）期间按 Enter 是"字母原文上屏"，
 * 不是发送指令。所有把 Enter 当快捷键的输入框必须先经过组合状态守卫。
 */

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

describe("IME composition guard", () => {
  test("isImeComposition detects composition-state keys", () => {
    // 标准浏览器：组合期 keydown 的 isComposing 为 true
    assert.equal(isImeComposition({ nativeEvent: { isComposing: true }, keyCode: 13 }), true);
    // 旧版 Safari：组合期 isComposing 缺失，keyCode 固定为 229
    assert.equal(isImeComposition({ nativeEvent: { isComposing: false }, keyCode: 229 }), true);
    // 正常按键不得被拦截
    assert.equal(isImeComposition({ nativeEvent: { isComposing: false }, keyCode: 13 }), false);
    assert.equal(isImeComposition({ nativeEvent: { isComposing: undefined }, keyCode: 65 }), false);
  });

  test("composer Enter-send runs only after the composition guard", () => {
    const guardIndex = appSource.indexOf("if (isImeComposition(event)) {");
    const sendIndex = appSource.indexOf("sendMessage(event as unknown as FormEvent<HTMLFormElement>)");
    assert.ok(guardIndex > 0, "composer onKeyDown must check isImeComposition");
    assert.ok(sendIndex > guardIndex, "composition guard must precede the Enter-send branch");
  });

  test("mention menu keys are ignored during composition", () => {
    const match = appSource.match(/function handleComposerKeyDown\([\s\S]*?\n  \}/);
    assert.ok(match, "handleComposerKeyDown must exist in App.tsx");
    assert.ok(
      match[0].indexOf("isImeComposition") >= 0 && match[0].indexOf("isImeComposition") < match[0].indexOf("ArrowDown"),
      "composition guard must precede mention candidate navigation",
    );
  });

  test("workspace rules Enter handler ignores composition keys", () => {
    const match = appSource.match(
      /onKeyDown=\{\(e\) => \{\s*if \(isImeComposition\(e\)\) \{\s*return;\s*\}\s*if \(e\.key === "Enter"\) \{\s*e\.preventDefault\(\);\s*addRule\(\);/,
    );
    assert.ok(match, "rules input onKeyDown must guard composition before addRule");
  });
});
