// Orbit 官网交互脚本
// 仅做 tab 切换与命令复制，不依赖任何外部库。
// 演示媒体配置集中在此：后续替换视频时只需修改 demoMedia 并在渲染分支中处理 video。

const demoMedia = {
  kind: "gif",
  src: "assets/orbit-complex-collaboration-demo.gif",
};

/**
 * 激活一组 tab 中的某个 tab：设置 aria-selected、tabindex、面板可见性。
 * 适用于命令卡 tabs 与设计思路 tabs。
 */
function activateTab(tabs, panels, target) {
  tabs.forEach((tab) => {
    const active = tab === target;
    tab.setAttribute("aria-selected", String(active));
    tab.classList.toggle("is-active", active);
    tab.tabIndex = active ? 0 : -1;
  });
  panels.forEach((panel) => {
    const show = panel.id === target.getAttribute("aria-controls");
    panel.classList.toggle("is-hidden", !show);
    if (show) {
      panel.removeAttribute("hidden");
    } else {
      panel.setAttribute("hidden", "");
    }
  });
}

/**
 * 在 tablist 内支持键盘左右（横向）或上下（纵向）切换。
 * @param {KeyboardEvent} event
 * @param {HTMLElement[]} tabs
 * @param {"horizontal"|"vertical"} orientation
 */
function handleTabKeydown(event, tabs, orientation) {
  const currentIndex = tabs.indexOf(document.activeElement);
  if (currentIndex === -1) return;
  const isHorizontal = orientation === "horizontal";
  const nextKey = isHorizontal ? "ArrowRight" : "ArrowDown";
  const prevKey = isHorizontal ? "ArrowLeft" : "ArrowUp";
  let nextIndex = null;
  if (event.key === nextKey) nextIndex = (currentIndex + 1) % tabs.length;
  else if (event.key === prevKey) nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;

  if (nextIndex !== null) {
    event.preventDefault();
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  }
}

/**
 * 复制文本到剪贴板：优先 navigator.clipboard，降级到 execCommand。
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 降级到下面的方式
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function setupCommandTabs() {
  const tabs = Array.from(document.querySelectorAll(".cmd-tabs .cmd-tab"));
  if (tabs.length === 0) return;
  const panels = tabs
    .map((t) => document.getElementById(t.getAttribute("aria-controls")))
    .filter(Boolean);
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tabs, panels, tab));
  });
  tabs[0].addEventListener("keydown", (e) =>
    handleTabKeydown(e, tabs, "horizontal")
  );
  tabs[1]?.addEventListener("keydown", (e) =>
    handleTabKeydown(e, tabs, "horizontal")
  );
}

function setupDesignTabs() {
  const tabs = Array.from(document.querySelectorAll(".design-tabs .design-tab"));
  if (tabs.length === 0) return;
  const panels = tabs
    .map((t) => document.getElementById(t.getAttribute("aria-controls")))
    .filter(Boolean);
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tabs, panels, tab));
    tab.addEventListener("keydown", (e) => handleTabKeydown(e, tabs, "vertical"));
  });
}

function setupCopyButtons() {
  const buttons = document.querySelectorAll(".copy-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy") || "";
      const label = btn.querySelector(".copy-label");
      const original = label ? label.textContent : "复制";
      const ok = await copyText(text);
      if (label) label.textContent = ok ? "已复制" : "复制失败";
      btn.classList.toggle("is-copied", ok);
      if (btn._timer) clearTimeout(btn._timer);
      btn._timer = setTimeout(() => {
        if (label) label.textContent = original;
        btn.classList.remove("is-copied");
      }, 1600);
    });
  });
}

/**
 * 演示媒体渲染：当前为 GIF，直接由 <img> 标签静态写入。
 * 预留 video 替换点：当 demoMedia.kind === "video" 时，可在此函数中把
 * #demo-media-el 替换为 <video controls autoplay loop muted playsinline>。
 * 当前实现保持 GIF 原样，仅做路径校验。
 */
function setupDemoMedia() {
  const el = document.getElementById("demo-media-el");
  if (!el) return;
  if (demoMedia.kind === "video") {
    // 后续替换视频时在此分支渲染 <video>；当前不触发。
    return;
  }
  // GIF：确保 src 与配置一致（统一来源）
  if (el.getAttribute("src") !== demoMedia.src) {
    el.setAttribute("src", demoMedia.src);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setupCommandTabs();
  setupDesignTabs();
  setupCopyButtons();
  setupDemoMedia();
});
