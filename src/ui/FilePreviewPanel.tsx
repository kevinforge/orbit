import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { FolderIcon } from "tdesign-icons-react";
import { LOCAL_PATH_LINK_CLASS, renderMarkdown } from "./markdown-renderer.ts";
import { highlightCodeHtml, previewLanguageFromPath, shouldHighlightCode } from "./code-highlight.ts";
import {
  buildPreviewLineNumbers,
  buildPreviewMetadataUrl,
  buildPreviewRawUrl,
  clampPreviewWidth,
  formatPreviewSize,
  previewFileName,
  prettifyJsonText,
  type FilePreviewMeta,
} from "./file-preview.ts";

/**
 * 右侧只读文件预览面板（issue #165）。
 *
 * 面板按元数据接口的类型分级渲染：文本按扩展名做语法高亮并带行号栏，
 * Markdown 直接内嵌渲染，图片与 PDF 走原生字节接口（<img> / <iframe>），
 * 二进制只给提示与定位入口。目录由 App 侧继续走资源管理器定位，面板自动
 * 关闭。单面板：点新文件时 App 替换 path 即可。左缘手柄拖拽调宽，宽度由
 * App 持有（三栏列宽与浮层宽度共用同一 CSS 变量）。
 */
export function FilePreviewPanel(props: {
  path: string;
  workspaceId: string;
  overlay: boolean;
  onClose: () => void;
  onReveal: (path: string) => void;
  onOpenPath: (path: string) => void;
  onResizeWidth: (width: number) => void;
}) {
  // 加载结果与路径绑定（PR #169 审查修复）：只在结果路径与当前 path 一致时
  // 渲染。此前在 useEffect 里才清空 meta，effect 又在 paint 之后运行，于是
  // 快速切换文件时首帧会用新标题渲染旧文件正文。
  const [loaded, setLoaded] = useState<{ path: string; meta: FilePreviewMeta } | null>(null);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const meta = loaded && loaded.path === props.path ? loaded.meta : null;
  const errorMessage = failure && failure.path === props.path ? failure.message : "";

  useEffect(() => {
    const controller = new AbortController();
    const requestPath = props.path;
    fetch(buildPreviewMetadataUrl(requestPath, props.workspaceId), { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as
          | (FilePreviewMeta & { ok?: true })
          | { ok: false; message?: string }
          | null;
        if (!response.ok || !data || data.ok === false) {
          throw new Error((data && "message" in data && data.message) || "无法预览该文件");
        }
        return data;
      })
      .then((data) => {
        if (data.kind === "directory") {
          props.onReveal(requestPath);
          props.onClose();
          return;
        }
        setLoaded({ path: requestPath, meta: data });
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name === "AbortError") return;
        setFailure({
          path: requestPath,
          message: reason instanceof Error ? reason.message : "无法预览该文件",
        });
      });
    return () => controller.abort();
    // path 或工作区变化即重新加载；回调闭包在此期间保持语义稳定（仅 setState）。
  }, [props.path, props.workspaceId]);

  // 左缘拖拽调宽：pointermove 里实时上报 clamp 后的宽度；与 App 的侧边栏
  // 拖拽同一套 window 级监听 + body 类（列光标、禁选中）模式。回调闭包
  // 仅做 setState，语义稳定，不进依赖。
  useEffect(() => {
    if (!isResizing) return;
    function handlePointerMove(event: globalThis.PointerEvent) {
      props.onResizeWidth(clampPreviewWidth(window.innerWidth - event.clientX, window.innerWidth));
    }
    function handlePointerUp() {
      setIsResizing(false);
      document.body.classList.remove("previewResizing");
    }
    document.body.classList.add("previewResizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      document.body.classList.remove("previewResizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizing]);

  // 高亮与行号按 (文本, 路径) 记忆：拖拽调宽会高频重渲染面板，1 MB 级
  // 文本不能每次 pointermove 都重新 tokenize。超过体积上限时退化为纯文本
  // （PR #169 审查修复）：hljs 与行号栏都在主线程同步执行，大文件会卡住界面。
  const codeView = useMemo(() => {
    if (meta?.kind !== "text") return null;
    if (!shouldHighlightCode(meta.content)) {
      return { plainText: true as const, text: meta.content };
    }
    const text = prettifyJsonText(meta.target, meta.content, meta.truncated) ?? meta.content;
    return {
      plainText: false as const,
      html: highlightCodeHtml(text, previewLanguageFromPath(meta.target)),
      lineNumbers: buildPreviewLineNumbers(text),
    };
  }, [meta]);

  // 渲染后的 Markdown 里可能仍含本地路径入口，与消息区一致走委托预览。
  function handleBodyClick(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLElement)) return;
    const entry = event.target.closest<HTMLElement>(`.${LOCAL_PATH_LINK_CLASS}`);
    const nestedPath = entry?.dataset.path;
    if (nestedPath) props.onOpenPath(nestedPath);
  }

  function handleBodyKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!(event.target instanceof HTMLElement)) return;
    const entry = event.target.closest<HTMLElement>(`.${LOCAL_PATH_LINK_CLASS}`);
    const nestedPath = entry?.dataset.path;
    if (!nestedPath) return;
    event.preventDefault();
    props.onOpenPath(nestedPath);
  }

  const fileName = previewFileName(props.path);

  return (
    <section className={`previewPanel${props.overlay ? " overlay" : ""}`} aria-label="文件预览">
      <div
        className="previewResizeHandle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整预览面板宽度"
        onPointerDown={(event) => {
          event.preventDefault();
          setIsResizing(true);
        }}
      />
      <header className="previewPanelHeader">
        <div className="previewPanelTitle" title={props.path}>
          <strong>{fileName}</strong>
          <span className="previewPanelPath">{props.path}</span>
        </div>
        <div className="previewPanelActions">
          <button
            type="button"
            className="previewPanelRevealBtn"
            onClick={() => props.onReveal(props.path)}
            title="在资源管理器中定位"
          >
            <FolderIcon />
          </button>
          <button type="button" className="previewPanelCloseBtn" onClick={props.onClose} title="关闭预览">&times;</button>
        </div>
      </header>

      {!meta && !errorMessage ? <div className="previewPanelState">正在加载预览…</div> : null}
      {errorMessage ? (
        <div className="previewPanelState previewPanelError" role="alert">
          <p>{errorMessage}</p>
          <p className="previewPanelHint">文件可能已被移动或删除，可在资源管理器中确认。</p>
        </div>
      ) : null}

      {meta?.kind === "text" && codeView ? (
        <div className="previewPanelBody previewCodeBody" onClick={handleBodyClick} onKeyDown={handleBodyKeyDown}>
          <div className="previewCode">
            {codeView.plainText ? null : (
              <div className="previewLineNumbers" aria-hidden="true">{codeView.lineNumbers}</div>
            )}
            {codeView.plainText ? (
              <pre className="previewText">{codeView.text}</pre>
            ) : (
              <pre className="previewText"><code dangerouslySetInnerHTML={{ __html: codeView.html }} /></pre>
            )}
          </div>
          {codeView.plainText ? (
            <div className="previewTruncatedNotice">文件较大，已关闭语法高亮与行号。</div>
          ) : null}
          {meta.truncated ? (
            <div className="previewTruncatedNotice">文件较大，仅显示前 1 MB（共 {formatPreviewSize(meta.size)}）。</div>
          ) : null}
        </div>
      ) : null}

      {meta?.kind === "markdown" ? (
        <div className="previewPanelBody" onClick={handleBodyClick} onKeyDown={handleBodyKeyDown}>
          <div className="markdown previewMarkdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(meta.content) }} />
          {meta.truncated ? (
            <div className="previewTruncatedNotice">文件较大，仅显示前 1 MB（共 {formatPreviewSize(meta.size)}）。</div>
          ) : null}
        </div>
      ) : null}

      {meta?.kind === "image" ? (
        <div className="previewPanelBody previewImageBody">
          <img className="previewImage" src={buildPreviewRawUrl(props.path, props.workspaceId)} alt={fileName} />
        </div>
      ) : null}

      {meta?.kind === "pdf" ? (
        <iframe className="previewPdf" src={buildPreviewRawUrl(props.path, props.workspaceId)} title={fileName} />
      ) : null}

      {meta?.kind === "binary" ? (
        <div className="previewPanelState">
          <p>该文件类型暂不支持在 Orbit 内预览（{formatPreviewSize(meta.size)}）。</p>
          <p className="previewPanelHint">可点击右上角文件夹按钮在资源管理器中定位并打开。</p>
        </div>
      ) : null}
    </section>
  );
}
