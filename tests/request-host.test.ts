import assert from "node:assert/strict";
import test from "node:test";

import { isLoopbackHostHeader } from "../src/server/request-host.ts";

/**
 * PR #169 审查修复：Orbit 的本地 API 没有鉴权，把监听地址收紧到 127.0.0.1
 * 之后仍存在 DNS rebinding——恶意页面用攻击者域名解析到回环地址，浏览器按
 * 同源发送请求，Host 却是攻击者域名。本测试钉住这条校验。
 */

test("isLoopbackHostHeader accepts loopback hostnames with and without a port", () => {
  assert.equal(isLoopbackHostHeader("localhost"), true);
  assert.equal(isLoopbackHostHeader("localhost:4317"), true);
  assert.equal(isLoopbackHostHeader("LOCALHOST:4317"), true, "host matching is case-insensitive");
  assert.equal(isLoopbackHostHeader("127.0.0.1"), true);
  assert.equal(isLoopbackHostHeader("127.0.0.1:4317"), true);
  assert.equal(isLoopbackHostHeader("[::1]"), true);
  assert.equal(isLoopbackHostHeader("[::1]:4317"), true);
});

test("isLoopbackHostHeader rejects any other host", () => {
  assert.equal(isLoopbackHostHeader("evil.example:4317"), false);
  assert.equal(isLoopbackHostHeader("192.168.1.20:4317"), false, "LAN clients cannot reach the API");
  assert.equal(isLoopbackHostHeader("0.0.0.0:4317"), false);
  assert.equal(isLoopbackHostHeader("127.0.0.1.nip.io:4317"), false, "rebinding hostnames must not pass");
  assert.equal(isLoopbackHostHeader("localhost.evil.example:4317"), false);
  // IPv6 字面量必须带方括号；裸 ::1 不是合法 Host，按畸形拒绝。
  assert.equal(isLoopbackHostHeader("::1"), false, "unbracketed IPv6 is malformed");
  assert.equal(isLoopbackHostHeader("not a host"), false, "malformed hosts are rejected");
});

test("isLoopbackHostHeader allows a missing Host header", () => {
  // 浏览器（DNS rebinding 的唯一载体）必然发送 Host；缺省放行以免误伤本机脚本。
  assert.equal(isLoopbackHostHeader(undefined), true);
  assert.equal(isLoopbackHostHeader(""), true);
});
