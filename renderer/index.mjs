// 会话来源过滤 — renderer module.
//
// PI-Desktop has no sidebar slot and no session-list filter API, so this module
// works on the sidebar the way a stylesheet would: it marks the rows that should
// disappear with one attribute, hides them with a style element it mounts
// itself, and adds a filter button to every project header.
//
// Row identity comes from the host's own contract:
//   PI-Desktop sessions   id is a uuid
//   native Pi sessions    id starts with "native-pi:"   (the rows badged "Pi")
//   remote host sessions  id starts with "remote:"
// `data-sidebar-session-row` carries exactly that id.
//
// Time buckets come from the host's own group headers: the rows above the first
// header are the newest bucket, and every header names the bucket below it.
//
// The menu is an allow-list: the checked keys say what stays visible. No key
// checked means "全部显示".

const ATTR = 'data-pi-session-filter';
const HIDDEN = 'hidden';

const ROW_SELECTOR = '[data-sidebar-session-row]';
const SIDEBAR_SELECTOR = '.sidebar-surface';
const LIST_SELECTOR = '.sidebar-session-group-list';
const TIME_HEADER_SELECTOR = '.sidebar-time-group-header';
const TIME_HEADER_CLASS = 'sidebar-time-group-header';
const PROJECT_HEADER_SELECTOR = '.sidebar-session-group-header';
const PROJECT_TITLE_SELECTOR = '.sidebar-session-group-title';

const BUTTON_CLASS = 'pi-session-filter-button';
const MENU_CLASS = 'pi-session-filter-menu';
const MENU_KEY_ATTR = 'data-pi-filter-key';
const STYLE_ATTR = 'data-pi-session-filter-style';

const NATIVE_PI_PREFIX = 'native-pi:';
const REMOTE_PREFIX = 'remote:';

// The host's own group labels, copied from PI-Desktop 0.20.1's locale bundles
// (en, zh-CN, zh-TW, de, es, fr, ko, pt-BR, tr). Matching the union means the
// time filter works whatever the app's language is.
const BUCKET_LABELS = {
  yesterday: ['Yesterday', '昨天', 'Ayer', 'Dün', 'Ontem', 'Hier', '어제', 'Gestern'],
  week: [
    'Previous 7 days',
    '近 7 天',
    'Anterior 7 días',
    'Önceki 7 gün',
    'Últimos 7 dias',
    '7 jours précédents',
    '최근 7일',
    'Vorherige 7 Tage',
  ],
  fortnight: [
    'Previous 14 days',
    '近 14 天',
    'Anterior 14 dias',
    'Önceki 14 gün',
    'Últimos 14 dias',
    'Précédent 14 jours',
    '최근 14일',
    'Vorherige 14 Tage',
  ],
  archived: ['Older', '更早', 'Anterior', 'Daha eski', 'Mais antigos', 'Plus ancien', '이전', 'Älter'],
};

const BUCKET_RANK = { newest: 0, yesterday: 1, week: 2, fortnight: 3, archived: 4 };
// "最新" covers the two newest buckets: the host renders today without a header
// and yesterday under its own.
const BUCKET_KEY = {
  newest: 'newest',
  yesterday: 'newest',
  week: 'week',
  fortnight: 'fortnight',
  archived: 'older',
};

const FILTER_KEYS = new Set(['desktop', 'pi', 'newest', 'week', 'fortnight', 'older']);

const MENU_TITLE = '过滤会话';
// Three groups, divided like the host's own sort menu. The first group is the
// "no filter" row, so it carries the empty key.
const MENU_GROUPS = [
  [{ key: '', label: '全部显示' }],
  [
    { key: 'desktop', label: 'PI-Desktop 原生会话' },
    { key: 'pi', label: 'Pi 会话' },
  ],
  [
    { key: 'newest', label: '最新' },
    { key: 'week', label: '近 7 天' },
    { key: 'fortnight', label: '近 14 天' },
    { key: 'older', label: '更早' },
  ],
];

const DEFAULT_CONFIG = Object.freeze({
  filters: 'desktop',
  hideRemote: false,
  hideEmptyTimeGroups: true,
  extraPrefixes: '',
});

// Re-scanning is throttled: the chat surface mutates on every streamed token,
// and one pass is cheap but not free.
const MUTATION_THROTTLE_MS = 120;
// Settings are read through the plugin process; a slow poll keeps the switches
// live without needing a plugin reload.
const CONFIG_POLL_MS = 2500;

// Lucide's `filter` glyph, the same shape and stroke weight the host's own
// header buttons use.
const FUNNEL_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/></svg>';
const STYLE = `
[${ATTR}="${HIDDEN}"] { display: none !important; }
/* Same box, colour and reveal-on-hover behaviour as the host's own project
   header buttons (see .sidebar-session-group-add / .thread-item-more). */
.${BUTTON_CLASS} {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-2xs, 4px);
  background: transparent;
  color: var(--ds-text-muted, currentColor);
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}
.sidebar-session-group-header:hover .${BUTTON_CLASS},
.sidebar-session-group-header:focus-within .${BUTTON_CLASS} {
  opacity: 1;
  pointer-events: auto;
}
/* A filter that hides sessions should not be invisible; it stays as a faint
   accent ghost until the header is hovered. */
.${BUTTON_CLASS}[data-pi-filter-active="true"] {
  opacity: 0.45;
  pointer-events: auto;
  color: var(--ds-accent, currentColor);
}
.sidebar-session-group-header:hover .${BUTTON_CLASS}[data-pi-filter-active="true"] {
  opacity: 1;
}
.${BUTTON_CLASS}:hover { background: var(--ds-bg-hover, rgba(127, 127, 127, 0.18)); }
/* The host's own divider is a 6px spacer with no line; draw one. */
.${MENU_CLASS} .sidebar-popover-divider {
  height: 1px;
  margin: 6px 0;
  background: var(--ds-border-subtle, rgba(127, 127, 127, 0.35));
}
.${MENU_CLASS} { position: fixed; z-index: 60; }
`;

let host = null;
let config = { ...DEFAULT_CONFIG };
let disposers = [];
let observer = null;
let pollTimer = null;
let scanTimer = null;
let menuElement = null;
let menuAnchor = null;

function parsePrefixes(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseFilters(value) {
  const keys = new Set();
  for (const part of String(value ?? '').split(',')) {
    const key = part.trim();
    if (FILTER_KEYS.has(key)) keys.add(key);
  }
  return keys;
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, fallback) => (typeof source[key] === 'boolean' ? source[key] : fallback);
  return {
    filters: typeof source.filters === 'string' ? source.filters : DEFAULT_CONFIG.filters,
    hideRemote: pick('hideRemote', DEFAULT_CONFIG.hideRemote),
    hideEmptyTimeGroups: pick('hideEmptyTimeGroups', DEFAULT_CONFIG.hideEmptyTimeGroups),
    extraPrefixes:
      typeof source.extraPrefixes === 'string' ? source.extraPrefixes : DEFAULT_CONFIG.extraPrefixes,
  };
}

function sameConfig(a, b) {
  return (
    a.filters === b.filters &&
    a.hideRemote === b.hideRemote &&
    a.hideEmptyTimeGroups === b.hideEmptyTimeGroups &&
    a.extraPrefixes === b.extraPrefixes
  );
}

function bucketOf(label) {
  const text = String(label ?? '').trim();
  if (!text) return null;
  for (const [bucket, labels] of Object.entries(BUCKET_LABELS)) {
    if (labels.includes(text)) return bucket;
  }
  return null;
}

function bucketKey(bucket) {
  return typeof bucket === 'string' && BUCKET_KEY[bucket] ? BUCKET_KEY[bucket] : null;
}

// Exported for the offline harness: pure decisions, no DOM.
export function shouldHideSession(id, bucket, cfg = DEFAULT_CONFIG) {
  if (typeof id !== 'string' || !id) return false;
  if (parsePrefixes(cfg.extraPrefixes).some((prefix) => id.startsWith(prefix))) return true;

  const keys = parseFilters(cfg.filters);
  if (keys.size === 0) return cfg.hideRemote === true && id.startsWith(REMOTE_PREFIX);

  const key = bucketKey(bucket);
  const timeMatch = key !== null && keys.has(key);

  // Remote rows carry no source label, so only the separate switch and the time
  // labels speak for them.
  if (id.startsWith(REMOTE_PREFIX)) {
    if (cfg.hideRemote) return true;
    if (key === null) return false;
    return !timeMatch;
  }

  // Everything else: shown when its source or its time bucket is checked.
  if (keys.has(id.startsWith(NATIVE_PI_PREFIX) ? 'pi' : 'desktop')) return false;
  return !timeMatch;
}

function setHidden(element, hidden) {
  if (hidden) {
    if (element.getAttribute(ATTR) !== HIDDEN) element.setAttribute(ATTR, HIDDEN);
    return;
  }
  if (element.hasAttribute(ATTR)) element.removeAttribute(ATTR);
}

function sidebarScope() {
  return document.querySelector(SIDEBAR_SELECTOR) ?? document;
}

// One pass over every session list: a row's bucket is the last header above it.
function collectBuckets(scope) {
  const buckets = new Map();
  for (const list of scope.querySelectorAll(LIST_SELECTOR)) {
    let bucket = 'newest';
    for (const node of list.children) {
      if (node.classList.contains(TIME_HEADER_CLASS)) {
        bucket = bucketOf(node.textContent);
        continue;
      }
      if (node.matches(ROW_SELECTOR)) buckets.set(node, bucket);
    }
  }
  return buckets;
}

function applyRows(scope, cfg) {
  const buckets = collectBuckets(scope);
  const rows = scope.querySelectorAll(ROW_SELECTOR);
  let hidden = 0;
  for (const row of rows) {
    const id = row.getAttribute('data-sidebar-session-row') ?? '';
    const hide = shouldHideSession(id, buckets.get(row), cfg);
    if (hide) hidden += 1;
    setHidden(row, hide);
  }
  return { total: rows.length, hidden };
}

// A time header owns the siblings up to the next time header. If every session
// under it is hidden, the header itself is noise.
function applyTimeHeaders(scope, cfg) {
  for (const header of scope.querySelectorAll(TIME_HEADER_SELECTOR)) {
    if (!cfg.hideEmptyTimeGroups) {
      setHidden(header, false);
      continue;
    }
    let sawRow = false;
    let hasVisibleRow = false;
    let sibling = header.nextElementSibling;
    while (sibling && !sibling.classList.contains(TIME_HEADER_CLASS)) {
      if (sibling.matches(ROW_SELECTOR)) {
        sawRow = true;
        if (sibling.getAttribute(ATTR) !== HIDDEN) {
          hasVisibleRow = true;
          break;
        }
      }
      sibling = sibling.nextElementSibling;
    }
    // Only a header whose rows were actually seen can be judged empty; an
    // unexpected layout is left alone rather than hidden by mistake.
    setHidden(header, sawRow && !hasVisibleRow);
  }
}

function apply(cfg = config) {
  if (!document || typeof document.querySelectorAll !== 'function') return null;
  const scope = sidebarScope();
  const rows = applyRows(scope, cfg);
  applyTimeHeaders(scope, cfg);
  ensureButtons(scope, cfg);
  if (menuAnchor && !menuAnchor.isConnected) closeMenu();
  return rows;
}

function scheduleApply() {
  if (scanTimer !== null) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    apply();
  }, MUTATION_THROTTLE_MS);
}

// The host's own `pi.ui.injectStyle` wraps every rule in
// `@scope ([data-pi-plugin="<id>"])`, which confines it to the plugin's own
// subtree — useless for touching the host's sidebar. The renderer module shares
// the host document, so it mounts a plain style element instead and removes it
// again on unload.
function mountStyle(css) {
  const element = document.createElement('style');
  element.setAttribute(STYLE_ATTR, 'true');
  element.textContent = css;
  document.head.append(element);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    element.remove();
  };
}

// ---------------------------------------------------------------- filter menu

function closeMenu() {
  if (!menuElement) return;
  menuElement.remove();
  menuElement = null;
  if (menuAnchor) menuAnchor.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
}

function positionMenu(anchor) {
  if (!menuElement) return;
  const rect = anchor.getBoundingClientRect();
  const width = menuElement.offsetWidth || 200;
  const height = menuElement.offsetHeight || 260;
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
  const top =
    rect.bottom + 6 + height > window.innerHeight - 8
      ? Math.max(8, rect.top - height - 6)
      : rect.bottom + 6;
  menuElement.style.left = `${Math.round(left)}px`;
  menuElement.style.top = `${Math.round(top)}px`;
}

function checkedSummary(filters) {
  const keys = parseFilters(filters);
  if (keys.size === 0) return '全部显示';
  const labels = [];
  for (const group of MENU_GROUPS) {
    for (const item of group) {
      if (item.key && keys.has(item.key)) labels.push(item.label);
    }
  }
  return labels.join('、');
}

function persistFilters() {
  if (!host) return;
  Promise.resolve(
    host.dispatch('plugin.call', { method: 'setFilters', args: { filters: config.filters } }),
  ).catch(() => {});
}

function toggleFilter(key) {
  const keys = parseFilters(config.filters);
  if (key === '') {
    keys.clear();
  } else if (keys.has(key)) {
    keys.delete(key);
  } else {
    keys.add(key);
  }
  config = { ...config, filters: [...keys].join(',') };
  apply();
  refreshMenu();
  persistFilters();
}

function buildMenu(anchor, cfg) {
  const checked = parseFilters(cfg.filters);
  const menu = document.createElement('div');
  menu.className = `sidebar-popover sidebar-sort-menu sidebar-floating-menu ${MENU_CLASS}`;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', MENU_TITLE);

  const title = document.createElement('div');
  title.className = 'sidebar-popover-title';
  title.textContent = MENU_TITLE;
  menu.append(title);

  MENU_GROUPS.forEach((group, index) => {
    if (index > 0) {
      const divider = document.createElement('div');
      divider.className = 'sidebar-popover-divider';
      menu.append(divider);
    }
    for (const item of group) {
      const selected = item.key === '' ? checked.size === 0 : checked.has(item.key);
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitemcheckbox');
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
      button.setAttribute(MENU_KEY_ATTR, item.key);
      if (selected) button.className = 'selected';

      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(label);

      if (selected) {
        const check = document.createElement('span');
        check.className = 'sidebar-sort-check';
        check.textContent = '✓';
        button.append(check);
      }

      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter(item.key);
      });
      menu.append(button);
    }
  });

  menu.addEventListener('pointerdown', (event) => event.stopPropagation());
  return menu;
}

// Ticking a box keeps the menu open, so the check marks have to be redrawn.
function refreshMenu() {
  if (!menuElement || !menuAnchor) return;
  const anchor = menuAnchor;
  const next = buildMenu(anchor, config);
  menuElement.replaceWith(next);
  menuElement = next;
  positionMenu(anchor);
}

function openMenu(anchor) {
  closeMenu();
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menuElement = buildMenu(anchor, config);
  document.body.append(menuElement);
  positionMenu(anchor);
}

function onDocumentPointerDown(event) {
  if (!menuElement) return;
  if (menuElement.contains(event.target) || (menuAnchor && menuAnchor.contains(event.target))) return;
  closeMenu();
}

function onDocumentKeyDown(event) {
  if (event.key === 'Escape') closeMenu();
}

function ensureButtons(scope, cfg) {
  const active = parseFilters(cfg.filters).size > 0;
  const label = `${MENU_TITLE}：${checkedSummary(cfg.filters)}`;
  for (const header of scope.querySelectorAll(PROJECT_HEADER_SELECTOR)) {
    const existing = header.querySelector(`.${BUTTON_CLASS}`);
    if (existing) {
      existing.setAttribute('data-pi-filter-active', active ? 'true' : 'false');
      existing.title = label;
      continue;
    }
    const title = header.querySelector(PROJECT_TITLE_SELECTOR);
    if (!title) continue;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.setAttribute('data-pi-filter-active', active ? 'true' : 'false');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.title = label;
    button.setAttribute('aria-label', MENU_TITLE);
    button.innerHTML = FUNNEL_ICON;
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menuAnchor === button) {
        closeMenu();
        return;
      }
      openMenu(button);
    });
    // The host's header handler ignores clicks that land on a button, so this
    // cannot switch projects.
    title.after(button);
  }
}

// ------------------------------------------------------------------- lifecycle

async function fetchConfig() {
  if (!host) return null;
  try {
    const answer = await host.dispatch('plugin.call', { method: 'getConfig', args: {} });
    if (!answer || typeof answer !== 'object') return null;
    return normalizeConfig(answer);
  } catch (error) {
    // A refused or unanswered call keeps the last known configuration.
    return null;
  }
}

async function syncConfig() {
  const next = await fetchConfig();
  if (!next || sameConfig(next, config)) return;
  config = next;
  apply();
}

function handleVisibility() {
  if (document.hidden) return;
  void syncConfig();
}

function handleViewportChange() {
  if (menuElement && menuAnchor) positionMenu(menuAnchor);
}

export async function onLoad(pi) {
  host = pi;
  disposers.push(mountStyle(STYLE));

  config = normalizeConfig(await fetchConfig());
  apply();

  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(scheduleApply);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener('visibilitychange', handleVisibility);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown, true);
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('scroll', handleViewportChange, true);

  pollTimer = setInterval(() => {
    void syncConfig();
  }, CONFIG_POLL_MS);
}

export async function onUnload() {
  closeMenu();
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (scanTimer !== null) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  document.removeEventListener('visibilitychange', handleVisibility);
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeyDown, true);
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('scroll', handleViewportChange, true);

  for (const element of document.querySelectorAll(`[${ATTR}]`)) element.removeAttribute(ATTR);
  for (const element of document.querySelectorAll(`.${BUTTON_CLASS}`)) element.remove();

  for (const dispose of disposers.splice(0)) {
    try {
      dispose();
    } catch (error) {
      // Nothing useful to do while unloading.
    }
  }

  host = null;
}

export const __internals = {
  normalizeConfig,
  parsePrefixes,
  parseFilters,
  bucketOf,
  checkedSummary,
  DEFAULT_CONFIG,
  MENU_GROUPS,
};
