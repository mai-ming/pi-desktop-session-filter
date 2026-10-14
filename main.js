'use strict';

// 会话来源过滤 — plugin process entry point.
//
// This process owns nothing visible. It answers the renderer module's config
// question, persists the filter set picked in the sidebar menu, and registers
// one declared resident service.
//
// The service exists because of how PI-Desktop boots. At startup the host
// restores enabled plugins *without* sending the renderer's `pluginChanged`
// event, and a renderer module only loads once the renderer has seen that event
// (its first plugin-list fetch happens before the restore loop reaches the
// plugin). A declared service makes the host announce the plugin while it loads,
// which is what pulls the renderer module in. `pi-desktop-xdpool` leans on the
// same behaviour. The service itself has no work to do.

const TOGGLE_COMMAND = 'pi-session-filter.toggle';
const SERVICE_ID = 'renderer-boot';

const FILTER_KEYS = new Set(['desktop', 'pi', 'newest', 'week', 'fortnight', 'older']);
const DEFAULT_FILTERS = 'desktop';

const DEFAULTS = {
  filters: DEFAULT_FILTERS,
  hideRemote: false,
  hideEmptyTimeGroups: true,
  extraPrefixes: '',
};

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

// The filter set is a comma-separated key list. An empty string is meaningful:
// it means "show everything".
function asFilters(value) {
  if (typeof value !== 'string') return DEFAULT_FILTERS;
  const keys = [];
  for (const part of value.split(',')) {
    const key = part.trim();
    if (FILTER_KEYS.has(key) && !keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) return value.trim() === '' ? '' : DEFAULT_FILTERS;
  return keys.join(',');
}

async function readSettings() {
  let raw = {};
  try {
    raw = (await pi.plugin.getSettings()) ?? {};
  } catch (error) {
    raw = {};
  }
  return {
    filters: asFilters(raw.filters),
    hideRemote: asBoolean(raw.hideRemote, DEFAULTS.hideRemote),
    hideEmptyTimeGroups: asBoolean(raw.hideEmptyTimeGroups, DEFAULTS.hideEmptyTimeGroups),
    extraPrefixes: typeof raw.extraPrefixes === 'string' ? raw.extraPrefixes : DEFAULTS.extraPrefixes,
  };
}

async function onLoad() {
  pi.services.register({ id: SERVICE_ID, start: async () => {}, stop: async () => {} });

  await pi.commands.register({
    id: TOGGLE_COMMAND,
    title: '切换 Pi（原生）会话屏蔽',
    keywords: ['session', 'filter', 'hide', 'pi', '会话', '过滤', '屏蔽', '来源'],
    run: async () => {
      const current = await readSettings();
      const next = current.filters === 'desktop' ? '' : 'desktop';
      await pi.plugin.setSettings({ filters: next });
      await pi.ui.showToast(next === 'desktop' ? '已屏蔽 Pi（原生）会话' : '已恢复显示全部会话');
    },
  });
}

async function onUnload() {
  try {
    await pi.services.unregister(SERVICE_ID);
  } catch (error) {
    // Unloading must not fail because the service was already gone.
  }
  try {
    await pi.commands.unregister(TOGGLE_COMMAND);
  } catch (error) {
    // Same for the command.
  }
}

// The renderer module cannot read plugin settings on its own, so these are the
// only renderer-reachable entry points.
async function onRendererCall(method, args) {
  if (method === 'getConfig') return readSettings();
  if (method === 'setFilters') {
    const filters = asFilters(args && args.filters);
    await pi.plugin.setSettings({ filters });
    return { filters };
  }
  throw new Error(`unknown renderer method: ${String(method)}`);
}

module.exports = { onLoad, onUnload, onRendererCall };
