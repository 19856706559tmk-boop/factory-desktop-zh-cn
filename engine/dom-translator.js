/**
 * Factory Desktop (v0.199.1+) Hardened DOM & Attribute Localization Engine
 * 4-Pillar Security & Performance Standard:
 * 1. Security: Zero innerHTML/insertAdjacentHTML/eval/network; pure TextNode.data & safe attributes;
 *    preserves Electron contextIsolation: true.
 * 2. React / ProseMirror / Shiki / xterm / Markdown Compatibility:
 *    Uses NodeFilter.FILTER_REJECT to completely skip ProseMirror editors, Shiki code blocks,
 *    Monaco editors, xterm terminals, diff viewers, and AI assistant markdown prose.
 * 3. Performance & Memory Safety:
 *    WeakMap O(1) node value cache prevents redundant work and infinite MutationObserver loops;
 *    80ms rAF-throttled observer with 600-node budget per frame for zero streaming jank.
 * 4. Language Switcher Respect:
 *    Checks document.documentElement.lang so switching to English in Settings is respected.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__FACTORY_ZH_DOM_ENGINE_LOADED__) return;
  Object.defineProperty(window, '__FACTORY_ZH_DOM_ENGINE_LOADED__', {
    value: true,
    writable: false,
    configurable: false
  });

  const LOCALE = typeof __FACTORY_ZH_LOCALE_DATA__ !== 'undefined' ? __FACTORY_ZH_LOCALE_DATA__ : null;
  if (!LOCALE || !LOCALE.exact) return;

  const EXACT = LOCALE.exact;
  const LOWER_EXACT = Object.create(null);
  for (const k of Object.keys(EXACT)) {
    const lk = k.toLowerCase();
    if (!LOWER_EXACT[lk]) LOWER_EXACT[lk] = EXACT[k];
  }
  const PREFIXES = Object.entries(LOCALE.prefixes || {});

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'SVG', 'PATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'TEMPLATE'
  ]);

  // Factory-specific DOM isolation selector:
  // Skips ProseMirror input, Shiki code blocks, xterm terminal, Monaco, diff code lines, and AI chat markdown
  const SKIP_SELECTOR = [
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '.ProseMirror',
    '.prosemirror',
    '.shiki',
    '.monaco-editor',
    '.xterm',
    '.xterm-screen',
    '.xterm-rows',
    '.cm-editor',
    '.lexical-editor',
    '.assistant-markdown',
    '.plain-prose',
    '.prose',
    '.markdown-body',
    '.diff-comment-markdown',
    '[data-markdown]',
    '[data-sf-markdown]',
    '[data-wiki-markdown-v2]',
    '[data-academy-markdown-v2]',
    '[data-message-markdown-table]',
    '[data-transcript-skeleton-prose]',
    '.code-line',
    '.line-content',
    'pre',
    'code'
  ].join(', ');

  // 'data-text' matters for shimmer status labels (the streaming "Streaming"/"Planning"
  // indicator): Factory renders them with a CSS `content: attr(data-text)` overlay plus
  // an attr()-based width sizer. Translating only the text node left the English overlay
  // visually stacked over the translated text, so both must stay in sync.
  const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label', 'data-text'];

  const REGEX_RULES = [
    [/^(\d+)\s+selected$/i, '已选择 $1 项'],
    [/^(\d+)\s+files?$/i, '$1 个文件'],
    [/^(\d+)\s+sessions?$/i, '$1 个会话'],
    [/^(\d+)\s+comments?$/i, '$1 条评论'],
    [/^(\d+)\s+matches$/i, '$1 个匹配项'],
    [/^(\d+)\s+match$/i, '$1 个匹配项'],
    [/^(\d+)\s+results?$/i, '$1 个结果'],
    [/^(\d+)\s+items?$/i, '$1 项'],
    [/^(\d+)\s+plugins?$/i, '$1 个插件'],
    [/^(\d+)\s+skills?$/i, '$1 个技能'],
    [/^(\d+)\s+tools?$/i, '$1 个工具'],
    [/^(\d+)\s+agents?$/i, '$1 个智能体'],
    [/^(\d+)\s+members?$/i, '$1 名成员'],
    [/^(\d+)\s+tasks?$/i, '$1 个任务'],
    [/^(\d+)\s+waiting$/i, '$1 个等待中'],
    [/^(\d+)\s+running$/i, '$1 个运行中'],
    [/^(\d+)\s+failed$/i, '$1 个失败'],
    [/^(\d+)\s+passed$/i, '$1 个已通过'],
    [/^(\d+)\s+pending$/i, '$1 个等待中'],
    [/^(\d+)\s+skipped$/i, '$1 个已跳过'],
    [/^(\d+)\s+canceled$/i, '$1 个已取消'],
    [/^(\d+)\s+additions?$/i, '$1 行新增'],
    [/^(\d+)\s+deletions?$/i, '$1 行删除'],
    [/^\+(\d+)\s+more$/i, '另外 $1 项'],
    [/^Show\s+(\d+)\s+more$/i, '显示另外 $1 项'],
    [/^Load\s+(\d+)\s+more$/i, '加载另外 $1 项'],
    [/^Step\s+(\d+)\s+of\s+(\d+)$/i, '第 $1 步，共 $2 步'],
    [/^Page\s+(\d+)\s+of\s+(\d+)$/i, '第 $1 页，共 $2 页'],
    [/^Page\s+(\d+)$/i, '第 $1 页'],
    [/^(\d+)–(\d+)\s+of\s+(\d+)$/i, '第 $1–$2 项，共 $3 项'],
    [/^(\d+)-(\d+)\s+of\s+(\d+)$/i, '第 $1-$2 项，共 $3 项'],
    [/^Showing\s+(\d+)\s+of\s+(\d+)$/i, '显示 $1 / $2'],
    [/^Thought\s+for\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?$/i, '已思考 $1 秒'],
    [/^Thinking\s+for\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?$/i, '已思考 $1 秒'],
    [/^(\d+)\s*s(?:ec(?:ond)?s?)?\s+elapsed$/i, '已用时 $1 秒'],
    [/^(\d+)\s*m(?:in(?:ute)?s?)?\s+ago$/i, '$1 分钟前'],
    [/^(\d+)\s*h(?:our)?s?\s+ago$/i, '$1 小时前'],
    [/^(\d+)\s*d(?:ay)?s?\s+ago$/i, '$1 天前'],
    [/^Last\s+(\d+)\s+days$/i, '过去 $1 天'],
    [/^Write\s+(\d+)\s+lines?$/i, '写入 $1 行'],
    [/^Delete\s+(\d+)\s+lines?$/i, '删除 $1 行'],
    [/^Edit\s+(\d+)\s+lines?$/i, '编辑 $1 行'],
    [/^Change\s+(\d+)\s+lines?$/i, '修改 $1 行'],
    [/^(\d+)\s+hidden\s+lines?$/i, '$1 行已隐藏'],
    [/^\.\.\.\s+and\s+(\d+)\s+more\s+lines?$/i, '... 以及另外 $1 行'],
    [/^Skills\s*\((\d+)\)$/i, '技能 ($1)'],
    [/^Connectors\s*\((\d+)\)$/i, '连接器 ($1)'],
    [/^Tools\s*\((\d+)\)$/i, '工具 ($1)'],
    [/^Agents\s*\((\d+)\)$/i, '智能体 ($1)'],
    [/^Filters\s*\((\d+)\)$/i, '筛选 ($1)'],
    [/^(\d+)m$/, '$1分'],
    [/^(\d+)h$/, '$1小时'],
    [/^(\d+)d$/, '$1天'],
    [/^(\d+)w$/, '$1周'],
    [/^(\d+)mo$/, '$1个月'],
    [/^(\d+)y$/, '$1年'],
    [/^\$(\d+(?:,\d{3})*(?:\.\d+)?)\s*\/\s*year$/i, '$$$1/年'],
    [/^\$(\d+(?:,\d{3})*(?:\.\d+)?)\s*\/\s*month$/i, '$$$1/月'],
    [/^\$(\d+(?:,\d{3})*(?:\.\d+)?)\s*\/\s*month\s*\+\s*\$(\d+(?:,\d{3})*(?:\.\d+)?)\s*\/\s*seat$/i, '$$$1/月 + $$$2/席位'],
    [/^组织设置\s*\(My Org\)$/i, '组织设置 (我的组织)']
  ];

  const translatedNodes = new WeakMap();
  const translatedAttrs = new WeakMap();

  function isZhActive() {
    const lang = document.documentElement && document.documentElement.lang;
    return !lang || lang === 'zh-CN' || lang.startsWith('zh');
  }

  function looksLikeCodeOrPath(s) {
    if (!s || s.length > 120) return true;
    if (/^(https?:\/\/|file:\/\/|[a-zA-Z]:[\\/]|\/Users\/|~\/|\.\.?\/|[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+)/.test(s)) return true;
    if (/^[a-zA-Z0-9_.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|json|jsonl|md|mdx|css|scss|less|html|htm|vue|svelte|sh|bash|zsh|yml|yaml|toml|ini|cfg|conf|env|lock|go|rs|java|kt|swift|c|cpp|h|hpp|cs|rb|php|sql|graphql|proto|dockerfile|makefile|gitignore)$/i.test(s)) return true;
    if (/^[a-z0-9]+(-[a-z0-9]+){2,}$/i.test(s)) return true;
    if (/^[0-9a-f]{7,40}$/i.test(s)) return true;
    if (/[{};=<>`\\]/.test(s)) return true;
    return false;
  }

  const DOM_SKIP_EXACT = new Set([
    'ID', 'OK', 'PR', 'ON', 'OFF', 'OR', 'API', 'URL', 'URI', 'SSH', 'Git', 'git',
    'MCP', 'CLI', 'SDK', 'CPU', 'GPU', 'RAM', 'UTC', 'EU', 'US', 'DEV', 'ESC', 'Esc',
    'main', 'master', 'dev', 'prod', 'staging', 'HEAD', 'Night Owl', 'monday.com',
    'Chrome DevTools', 'Teams', 'TEAMS', 'Monday', 'Zoom', 'Graphite', 'Linear',
    'Slack', 'Jira', 'GitHub', 'GitLab', 'Bitbucket', 'Notion', 'Figma', 'Sentry',
    'Datadog', 'PagerDuty', 'Asana', 'Confluence', 'Intercom', 'Zendesk', 'HubSpot',
    'Salesforce', 'Stripe', 'Snowflake', 'BigQuery', 'ClickHouse', 'Postgres',
    'PostgreSQL', 'Supabase', 'Vercel', 'Cloudflare', 'Buildkite', 'CircleCI',
    'PostHog', 'Amplitude', 'LaunchDarkly', 'Incident.io', 'Rootly', 'Shortcut',
    'Airtable', 'Box', 'Dropbox', 'OneDrive', 'SharePoint', 'Outlook',
    'Google Docs', 'Google Drive', 'Google Sheets', 'Google Slides',
    'Google Calendar', 'Google Maps', 'Google Chat', 'Google Cloud',
    'Finder', 'VS Code', 'Cursor', 'Windsurf', 'Zed', 'Xcode', 'Android Studio',
    'IntelliJ IDEA', 'WebStorm', 'PyCharm', 'GoLand', 'Sublime Text',
    'Ghostty', 'iTerm', 'iTerm2', 'Warp', 'Alacritty', 'Kitty', 'WezTerm',
    'Hyper', 'Docker', 'OrbStack', 'Tailscale', '1Password', 'Raycast',
    'Homebrew', 'Factory', 'Droid', 'Software Factory', 'OpenCompute', 'AutoWiki'
  ]);

  function canUseLowerFallback(s) {
    return s.length >= 4 && s.length <= 50 && !/^[A-Z0-9_./:-]+$/.test(s);
  }

  function translateText(raw) {
    if (!raw || typeof raw !== 'string') return null;
    if (raw.length > 260) return null;

    const trimmed = raw.trim();
    if (!trimmed || trimmed.length < 2) return null;
    if (!/[a-zA-Z]/.test(trimmed)) return null;
    if (DOM_SKIP_EXACT.has(trimmed)) return null;
    if (looksLikeCodeOrPath(trimmed)) return null;

    if (Object.prototype.hasOwnProperty.call(EXACT, trimmed)) {
      const target = EXACT[trimmed];
      if (target === trimmed) return null;
      return raw.replace(trimmed, () => target);
    }

    // Handle trailing punctuation (: or ... or …)
    const punctMatch = trimmed.match(/^(.+?)(\s*[:：]|\.\.\.|…)$/);
    if (punctMatch) {
      const base = punctMatch[1].trim();
      const suffix = punctMatch[2];
      if (!DOM_SKIP_EXACT.has(base) && !looksLikeCodeOrPath(base)) {
        const zhBase = Object.prototype.hasOwnProperty.call(EXACT, base)
          ? EXACT[base]
          : (canUseLowerFallback(base) ? LOWER_EXACT[base.toLowerCase()] : null);
        if (zhBase && zhBase !== base) {
          return raw.replace(trimmed, () => zhBase + suffix);
        }
      }
    }

    if (canUseLowerFallback(trimmed) && LOWER_EXACT[trimmed.toLowerCase()]) {
      const target = LOWER_EXACT[trimmed.toLowerCase()];
      if (target !== trimmed) {
        return raw.replace(trimmed, () => target);
      }
    }

    for (let i = 0; i < REGEX_RULES.length; i++) {
      const [re, replacement] = REGEX_RULES[i];
      if (re.test(trimmed)) {
        const res = trimmed.replace(re, replacement);
        return raw.replace(trimmed, () => res);
      }
    }

    if (trimmed.length <= 75) {
      for (let i = 0; i < PREFIXES.length; i++) {
        const [enPrefix, zhPrefix] = PREFIXES[i];
        if (trimmed.startsWith(enPrefix) && trimmed.length > enPrefix.length) {
          const rest = trimmed.slice(enPrefix.length);
          const restTrim = rest.trim();
          if (DOM_SKIP_EXACT.has(restTrim) || looksLikeCodeOrPath(restTrim)) continue;
          const zhRest = Object.prototype.hasOwnProperty.call(EXACT, restTrim)
            ? EXACT[restTrim]
            : (canUseLowerFallback(restTrim) ? LOWER_EXACT[restTrim.toLowerCase()] : null);
          if (zhRest) {
            return raw.replace(trimmed, () => zhPrefix + zhRest);
          }
          if (!/[a-z]{2,}/.test(restTrim)) {
            return raw.replace(trimmed, () => zhPrefix + rest);
          }
        }
      }
    }

    return null;
  }

  function isSkippedElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    try {
      if (el.closest && el.closest(SKIP_SELECTOR)) return true;
    } catch (_) {}
    return false;
  }

  function processTextNode(node) {
    try {
      const val = node.nodeValue;
      if (!val || translatedNodes.get(node) === val) return;

      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName) || parent.isContentEditable) {
        translatedNodes.set(node, val);
        return;
      }

      const next = translateText(val);
      if (next && next !== val) {
        node.nodeValue = next;
        translatedNodes.set(node, next);
      } else {
        translatedNodes.set(node, val);
      }
    } catch (_) {}
  }

  function processElementAttrs(el) {
    try {
      if (!el || el.nodeType !== 1) return;
      let cache = translatedAttrs.get(el);
      for (let i = 0; i < TRANSLATABLE_ATTRS.length; i++) {
        const attr = TRANSLATABLE_ATTRS[i];
        if (el.hasAttribute(attr)) {
          const val = el.getAttribute(attr);
          if (!val || (cache && cache[attr] === val)) continue;
          const next = translateText(val);
          if (!cache) {
            cache = Object.create(null);
            translatedAttrs.set(el, cache);
          }
          if (next && next !== val) {
            cache[attr] = next;
            el.setAttribute(attr, next);
          } else {
            cache[attr] = val;
          }
        }
      }
    } catch (_) {}
  }

  function walkRoot(root, maxNodes) {
    try {
      if (!root || !isZhActive()) return 0;
      if (root.isConnected === false) return 0;
      if (root.nodeType === 3) {
        const p = root.parentElement;
        if (p && !isSkippedElement(p)) processTextNode(root);
        return 1;
      }
      if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return 0;
      if (root.nodeType === 1 && isSkippedElement(root)) return 0;

      if (root.nodeType === 1) processElementAttrs(root);

      let count = 1;
      const limit = maxNodes || 3000;
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            try {
              if (node.nodeType === 1) {
                if (SKIP_TAGS.has(node.tagName) || node.isContentEditable) {
                  return NodeFilter.FILTER_REJECT;
                }
                if (node.matches && node.matches(SKIP_SELECTOR)) {
                  return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
              }
              return NodeFilter.FILTER_ACCEPT;
            } catch (_) {
              return NodeFilter.FILTER_REJECT;
            }
          }
        }
      );

      let current = walker.nextNode();
      while (current && count < limit) {
        count++;
        if (current.nodeType === 3) {
          processTextNode(current);
        } else if (current.nodeType === 1) {
          processElementAttrs(current);
        }
        current = walker.nextNode();
      }
      return count;
    } catch (_) {
      return 0;
    }
  }

  const pendingRoots = new Set();
  let scheduled = false;
  const MAX_FRAME_BUDGET = 600;

  function deduplicateRoots(roots) {
    const connected = [];
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      if (r && r.isConnected !== false) connected.push(r);
    }
    if (connected.length <= 1) return connected;
    const elemSet = new Set();
    for (let i = 0; i < connected.length; i++) {
      if (connected[i].nodeType === 1) elemSet.add(connected[i]);
    }
    if (elemSet.size === 0) return connected;
    const out = [];
    for (let i = 0; i < connected.length; i++) {
      const node = connected[i];
      let p = node.parentNode;
      let covered = false;
      while (p) {
        if (elemSet.has(p)) {
          covered = true;
          break;
        }
        p = p.parentNode;
      }
      if (!covered) out.push(node);
    }
    return out;
  }

  function flushPending() {
    scheduled = false;
    try {
      if (!isZhActive()) {
        pendingRoots.clear();
        return;
      }
      const rawRoots = Array.from(pendingRoots);
      pendingRoots.clear();
      const roots = deduplicateRoots(rawRoots);
      let remainingBudget = MAX_FRAME_BUDGET;
      for (let i = 0; i < roots.length; i++) {
        if (remainingBudget <= 0) {
          // Defer remaining roots to next throttled tick so frame never janks
          for (let j = i; j < roots.length; j++) pendingRoots.add(roots[j]);
          scheduleFlushTimer();
          break;
        }
        const used = walkRoot(roots[i], remainingBudget);
        remainingBudget -= used;
      }
    } catch (_) {}
  }

  function scheduleFlushTimer() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(flushPending);
      } else {
        flushPending();
      }
    }, 80);
  }

  function scheduleWalk(node) {
    if (!node || node.isConnected === false) return;
    pendingRoots.add(node);
    scheduleFlushTimer();
  }

  function startObserver() {
    try {
      if (!document.body) return;
      walkRoot(document.body, 5000);

      const observer = new MutationObserver((mutations) => {
        try {
          if (!isZhActive()) return;
          for (let i = 0; i < mutations.length; i++) {
            const m = mutations[i];
            if (m.type === 'characterData') {
              const target = m.target;
              if (target && translatedNodes.get(target) !== target.nodeValue) {
                scheduleWalk(target);
              }
            } else if (m.type === 'attributes') {
              if (m.target && !isSkippedElement(m.target)) {
                processElementAttrs(m.target);
              }
            } else if (m.type === 'childList') {
              const added = m.addedNodes;
              for (let j = 0; j < added.length; j++) {
                scheduleWalk(added[j]);
              }
            }
          }
        } catch (_) {}
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATABLE_ATTRS
      });
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }
})();
