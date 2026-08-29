import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Issue #116: sending the first message from a page with no active conversation.
 *
 * The server creates a conversation on demand when the POST carries an empty
 * conversationId, and returns that id in the response body. The client used to
 * ignore the body entirely, so:
 *
 *   1. `state.conversation.id` stayed "" and every later message created yet
 *      another conversation.
 *   2. `applyEvent` drops events whose `conversationId` does not match
 *      `state.conversation.id`, so the message and its replies never rendered.
 *
 * There is no React rendering harness in this repo, so this mirrors the
 * source-scanning style used by the other UI tests (e.g.
 * switch-conversation-view.test.ts).
 */

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

/** Extract the body of a function/method by name (matches `name(...) {`). */
function extractFunctionBody(source: string, name: string): string | null {
  const regex = new RegExp(`${name}\\([^)]*\\)[^{]*\\{`, "g");
  let match;
  while ((match = regex.exec(source)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    return source.slice(start, i - 1);
  }
  return null;
}

const sendMessageBody = extractFunctionBody(appSource, "sendMessage");

describe("Issue #116: first message adopts the conversation created by the server", () => {
  test("sendMessage reads conversationId from the POST response", () => {
    assert.ok(sendMessageBody, "Could not find sendMessage() in App.tsx");

    assert.match(
      sendMessageBody,
      /await response\.json\(\)/,
      "sendMessage must read the response body, otherwise the server-created conversation id is lost. " +
        "Got body:\n" + sendMessageBody,
    );
    assert.match(
      sendMessageBody,
      /sentConversationId/,
      "sendMessage must derive the returned conversation id into a local before adopting it. " +
        "Got body:\n" + sendMessageBody,
    );
  });

  test("adopted conversation id reaches state and the address bar", () => {
    assert.ok(sendMessageBody, "Could not find sendMessage() in App.tsx");

    assert.match(
      sendMessageBody,
      /conversation:\s*\{\s*\.\.\.current\.conversation,\s*id:\s*sentConversationId\s*\}/,
      "state.conversation.id must be updated with the returned id, otherwise SSE events are " +
        "filtered out by applyEvent and later messages create duplicate conversations. " +
        "Got body:\n" + sendMessageBody,
    );
    assert.match(
      sendMessageBody,
      /window\.history\.replaceState\([^)]*pageContextQuery\(nextContext\)/,
      "The address bar must be updated with the new conversation id so the page context stays " +
        "the source of truth across reloads and per-tab isolation. Got body:\n" + sendMessageBody,
    );
  });

  test("address bar is updated before the state request", () => {
    assert.ok(sendMessageBody, "Could not find sendMessage() in App.tsx");

    const urlIdx = sendMessageBody.indexOf("window.history.replaceState");
    const refreshIdx = sendMessageBody.indexOf("refreshState(nextContext)");

    assert.notStrictEqual(urlIdx, -1, "URL must be synced with the new conversation id");
    assert.notStrictEqual(
      refreshIdx,
      -1,
      "A full state refresh must follow as a safety net: the message.created event can arrive " +
        "before the conversation id lands and would then be dropped with no replay.",
    );
    assert.ok(
      urlIdx < refreshIdx,
      "window.history.replaceState must run BEFORE refreshState(nextContext). refreshState " +
        "validates the address bar against the requested context and discards responses that " +
        "arrive before the URL is updated. Got body:\n" + sendMessageBody,
    );
  });

  test("clientMessageId is reused across retries and reset after success", () => {
    assert.ok(sendMessageBody, "Could not find sendMessage() in App.tsx");

    assert.match(
      sendMessageBody,
      /clientMessageId:\s*draftMessageIdRef\.current/,
      "The idempotency key must come from a ref so a failed send can be retried under the same " +
        "clientMessageId. Regenerating it per attempt defeats the server-side dedupe and " +
        "duplicates the message. Got body:\n" + sendMessageBody,
    );
    assert.doesNotMatch(
      sendMessageBody,
      /clientMessageId:\s*crypto\.randomUUID\(\)/,
      "clientMessageId must not be generated inline per attempt. Got body:\n" + sendMessageBody,
    );
    assert.match(
      sendMessageBody,
      /draftMessageIdRef\.current = null;/,
      "The draft id must be cleared after a successful send so the next message gets a new key. " +
        "Got body:\n" + sendMessageBody,
    );
  });

  test("changed draft content gets a fresh idempotency key", () => {
    assert.ok(sendMessageBody, "Could not find sendMessage() in App.tsx");

    assert.match(
      sendMessageBody,
      /draftMessageIdRef\.current\.content !== trimmed/,
      "The draft id must be regenerated when the draft content changes. Otherwise, if a request " +
        "reached the server but its response was lost, retrying edited text would reuse the old " +
        "clientMessageId — the server dedupes it and reports success while the new content never " +
        "arrives. Got body:\n" + sendMessageBody,
    );
    assert.match(
      sendMessageBody,
      /draftMessageIdRef\.current = \{\s*id:\s*crypto\.randomUUID\(\),\s*content:\s*trimmed\s*\}/,
      "The draft id must be stored alongside the content it was generated for, so a retry can tell " +
        "'same content, retry the same message' apart from 'edited content, a new message'. " +
        "Got body:\n" + sendMessageBody,
    );
  });

  test("browser back/forward re-syncs state from the address bar", () => {
    assert.match(
      appSource,
      /window\.addEventListener\("popstate"/,
      "Page-context navigation uses pushState/replaceState, so without a popstate listener " +
        "browser back/forward leaves the UI out of sync with the URL and later state responses " +
        "are discarded by the context guard.",
    );
    assert.match(
      appSource,
      /refreshState\(readPageContext\(window\.location\.search\)\)/,
      "The popstate handler must pull state for the URL's page context.",
    );
  });
});
