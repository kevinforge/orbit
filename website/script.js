function setupWorkflowTabs() {
  const tabs = Array.from(document.querySelectorAll('.workflow-tab'));
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls'))).filter(Boolean);
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      tabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
      });
      panels.forEach((panel, panelIndex) => {
        const active = panelIndex === index;
        panel.classList.toggle('is-hidden', !active);
        if (active) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      });
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const horizontal = window.matchMedia('(max-width: 680px)').matches;
      const forward = horizontal ? ['ArrowRight', 'ArrowDown'].includes(event.key) : event.key === 'ArrowDown';
      const backward = horizontal ? ['ArrowLeft', 'ArrowUp'].includes(event.key) : event.key === 'ArrowUp';
      const current = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : forward ? (current + 1) % tabs.length : backward ? (current - 1 + tabs.length) % tabs.length : current;
      tabs[next].focus();
      tabs[next].click();
    });
  });
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function setupCopyButton() {
  document.querySelectorAll('.copy-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const original = button.textContent;
      const copied = await copyText(button.dataset.copy || '');
      button.textContent = copied ? '已复制' : '复制失败';
      button.classList.toggle('is-copied', copied);
      window.setTimeout(() => {
        button.textContent = original;
        button.classList.remove('is-copied');
      }, 1600);
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupWorkflowTabs();
  setupCopyButton();
});
