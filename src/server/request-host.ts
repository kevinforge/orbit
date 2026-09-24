/**
 * Loopback Host 校验（PR #169 审查修复）。
 *
 * Orbit 的本地 HTTP API 没有鉴权，因此只接受回环 Host。把监听地址收紧到
 * 127.0.0.1 只能挡住局域网直连，挡不住 DNS rebinding：恶意页面用攻击者域名
 * 解析到 127.0.0.1 后，浏览器发出的请求在页面看来仍是同源，于是绕过 CORS
 * 读取响应，而 `Host` 头是攻击者域名。校验 Host 才能关掉这条路径。
 *
 * 非浏览器客户端（脚本、curl）可能不带 Host；rebinding 必然携带 Host，
 * 所以缺省视为允许，避免误伤本机工具。
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** 判断请求的 Host 头是否指向本机回环地址。 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}
