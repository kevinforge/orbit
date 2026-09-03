import { marked } from "marked";

const safeProtocols = ["https:", "http:", "mailto:", "tel:"];

// GFM autolink 会把紧邻的 CJK 字符与全角标点吞进 URL（"…/a。"、
// "…/orbit了解更多"），导致打开被污染的地址。仅剥离尾随 run，被剥离的
// 字符保留为正文（issue #143）。覆盖 CJK 标点（U+3000–303F）、CJK 统一
// 表意文字（U+4E00–9FFF）与全角形式（U+FF00–FFEF）。
const trailingCjk = /[　-〿一-鿿＀-￯]+$/u;
// 显式 [文本](url) 链接的 URL 可以合法地以中文路径段结尾（维基百科条目
// wiki/数学），汉字必须原样保留；只有紧邻的全角标点才是输入法笔误。
const trailingCjkPunctuation = /[　-〿＀-￯]+$/u;

function stripTrailingCjk(href: string): { href: string; stripped: string } {
  const match = trailingCjk.exec(href);
  if (!match) return { href, stripped: "" };
  return { href: href.slice(0, match.index), stripped: match[0] };
}

function stripTrailingCjkPunctuation(href: string): { href: string; stripped: string } {
  const match = trailingCjkPunctuation.exec(href);
  if (!match) return { href, stripped: "" };
  return { href: href.slice(0, match.index), stripped: match[0] };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrl(href: string): string {
  try {
    const url = new URL(href, "https://placeholder.invalid");
    if (!safeProtocols.includes(url.protocol)) return "";
  } catch {
    return "";
  }
  return href;
}

// --- 本地路径入口（issue #143；issue #165 起默认打开预览）---
// 消息里的本地路径（X:/、X:\、~/、/ 开头，含 file:/// 前缀）不是可导航的
// Web URL：交给 sanitizeUrl 会被当成占位域下的站内相对链接。这里在 sanitize
// 之前分流，渲染成带 data-path 的 span，由 App 层的点击委托打开右侧只读
// 预览面板；在资源管理器中定位降级为面板内按钮。只动渲染层，不改消息存储。
export const LOCAL_PATH_LINK_CLASS = "localPathLink";

function renderLocalPathEntry(path: string, text: string): string {
  return `<span class="${LOCAL_PATH_LINK_CLASS}" data-path="${escapeHtml(path)}" role="button" tabindex="0" title="点击预览文件内容">${escapeHtml(text)}</span>`;
}

// file:///D:/x 与 file:///home/x 都剥掉 file:// 前缀；file://host/ 形式指向
// 远程主机，不识别。
function localPathFromHref(href: string): string | null {
  let candidate = href;
  if (/^file:\/\//i.test(candidate)) {
    if (!/^file:\/\/\//i.test(candidate)) return null;
    candidate = candidate.replace(/^file:\/\//i, "");
    // file:///D:/x 剥完是 "/D:/x"，去掉前导斜杠还原盘符路径。
    if (/^\/[A-Za-z]:[\\/]/.test(candidate)) candidate = candidate.slice(1);
  }
  // 显式链接 href 里紧邻路径的半角/全角标点属于正文（"[配置](D:/a.json。)"），
  // 与裸路径 tokenizer 同样剥离，剥完重新校验形态避免残段生成坏入口。
  candidate = candidate.replace(trailingPunctuation, "").replace(trailingCjkPunctuation, "");
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return candidate;
  if (/^~[\\/]/.test(candidate)) return candidate;
  // POSIX 绝对路径：显式写出的链接意图明确，单段（/tmp）也接受。
  if (/^\/[^\s]/.test(candidate)) return candidate;
  return null;
}

// 裸路径（无 markdown 链接语法包裹）用 inline tokenizer 扩展识别。字符集
// 支持 Unicode 路径名，同时排除会改变 Markdown/HTML 结构的字符。路径与相邻
// 中文正文之间没有分隔符时无法可靠判断边界，因此优先依赖空白或标点结束路径。
const pathChars = "[^\\s`<>|。，、！？；：（）［］｛｝《》「」『』【】…]";
const bareLocalPath = new RegExp(
  `^(?:[A-Za-z]:[\\\\/]${pathChars}+|~[\\\\/]${pathChars}+|/${pathChars}+(/${pathChars}+)+)`,
);
// 路径末尾紧邻的半角标点属于正文而非路径（"…/App.tsx."、"…/a.txt),"）。
const trailingPunctuation = /[.,;:!?)>'"。，、！？；：（）［］｛｝《》「」『』【】…]+$/u;

// 裸 POSIX 路径是三种前缀里信号最弱的：正文里「词/词/词」形态（工具栏/
// 翻页/搜索、http/https/mailto、加载/错误/404/截断）与 /段/段 的形状完
// 全重合，且 inline tokenizer 只能看到后续文本、看不到斜杠前的正文，无
// 法用前文区分（用户反馈的截图样例，issue #165）。因此裸 POSIX 仅在路
// 径形态足够强时识别：末段是带扩展名的文件名（不以点开头，支持 Unicode
// 文件名）、末段是常见无扩展名文件名、首段是常见根目录或单字母盘符段
// （Git Bash 的 /d/…、WSL 的 /mnt/…）、或以目录斜杠结尾。其余无扩展
// 目录串请写显式链接；[x](/path) 与 file:/// 分支意图明确，不受此收紧
// 影响。
const posixRootSegments = new Set([
  "usr", "home", "tmp", "var", "etc", "opt", "mnt", "srv", "root", "bin",
  "sbin", "lib", "lib64", "media", "run", "data", "app", "apps", "workspace",
  "workspaces", "users", "projects", "code", "repo", "www", "logs", "sites",
  "source", "src", "storage",
]);
const extensionlessFileNames = new Set([
  "makefile", "dockerfile", "license", "licence", "notice", "codeowners",
  "readme", "changelog", "gemfile", "rakefile", "brewfile", "procfile", "jenkinsfile",
]);

function looksLikePosixFilePath(path: string): boolean {
  if (/\/$/.test(path)) return true; // 目录形态 /var/log/
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  // name.ext：不以点开头（".docx/.doc" 这类扩展名串不是文件名）。
  if (/^[^./][^/]*\.[^./]+$/.test(last)) return true;
  if (extensionlessFileNames.has(last.toLowerCase())) return true;
  const first = segments[0] ?? "";
  return /^[a-z]$/i.test(first) || posixRootSegments.has(first.toLowerCase());
}

const localPathLinkExtension = {
  name: "localPathLink",
  level: "inline" as const,
  start(src: string): number | undefined {
    const match = new RegExp(`[A-Za-z]:[\\\\/]|~[\\\\/]|/${pathChars}+/`).exec(src);
    return match?.index;
  },
  tokenizer(src: string) {
    const match = bareLocalPath.exec(src);
    if (!match) return undefined;
    const trimmed = match[0].replace(trailingPunctuation, "");
    // 剥掉尾随标点后可能只剩 "D:/" 之类的残段，重新校验避免生成坏入口。
    if (!bareLocalPath.test(trimmed)) return undefined;
    // 裸 POSIX 形态过弱，需通过强路径特征才生成入口，否则词组会被误链。
    if (trimmed.startsWith("/") && !looksLikePosixFilePath(trimmed)) return undefined;
    return { type: "localPathLink", raw: trimmed, tokens: [], path: trimmed };
  },
  renderer(token: { path: string }): string {
    return renderLocalPathEntry(token.path, token.path);
  },
};

marked.use({
  extensions: [localPathLinkExtension],
  renderer: {
    html({ text }: { text: string }): string {
      return escapeHtml(text);
    },
    link({ href, text }: { href: string; text: string }): string {
      const localPath = localPathFromHref(href);
      if (localPath !== null) {
        return renderLocalPathEntry(localPath, text);
      }
      // GFM autolink 的文本就是原始 URL，紧邻 CJK（含汉字）被吞进 href 时
      // 二者同步剥离、被剥字符拼回正文；显式 [文本](url) 的 href 是用户
      // 书写的地址，只剥尾随全角标点笔误，汉字路径段原样保留。
      const { href: cleanHref, stripped } = text === href
        ? stripTrailingCjk(href)
        : stripTrailingCjkPunctuation(href);
      const safeHref = sanitizeUrl(cleanHref);
      const linkText = text === href ? cleanHref : text;
      if (!safeHref) {
        return `${escapeHtml(linkText)}${escapeHtml(stripped)}`;
      }
      return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkText)}</a>${escapeHtml(stripped)}`;
    },
    image({ href, text }: { href: string; text: string }): string {
      const safeHref = sanitizeUrl(href);
      if (!safeHref) return escapeHtml(text);
      return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}" />`;
    },
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = lang || "";
      const langLabel = language ? `<span class="codeLang">${escapeHtml(language)}</span>` : "";
      return `<div class="codeBlock"><div class="codeHeader">${langLabel}<button class="codeCopyBtn" type="button" onclick="(function(btn){var c=btn.closest('.codeBlock').querySelector('code');navigator.clipboard.writeText(c.textContent);btn.textContent='✓';btn.classList.add('copied');setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied');},1500)})(this)">Copy</button></div><pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string;
}
