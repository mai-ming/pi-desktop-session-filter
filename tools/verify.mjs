// Offline harness for renderer/index.mjs and main.js.
//
// It loads the real renderer module into a jsdom document built from
// tools/fixture.mjs (which mirrors the sidebar markup of PI-Desktop 0.20.1) and
// drives it through the states the host produces. Run with:  npm test
//
// Requires jsdom:  npm install

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { buildSidebarHtml, row, IDS } from './fixture.mjs';

const require = createRequire(import.meta.url);

const ATTR = 'data-pi-session-filter';
const HIDDEN = 'hidden';
const BUTTON_CLASS = 'pi-session-filter-button';
const MENU_CLASS = 'pi-session-filter-menu';
const KEY_ATTR = 'data-pi-filter-key';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dom = new JSDOM(buildSidebarHtml(), { url: 'http://localhost/', pretendToBeVisual: true });
const { document } = dom.window;

globalThis.window = dom.window;
globalThis.document = document;
globalThis.MutationObserver = dom.window.MutationObserver;

const module = await import('../renderer/index.mjs');

const state = {
  config: { filters: 'desktop', hideRemote: false, hideEmptyTimeGroups: true, extraPrefixes: '' },
  injectedCss: [],
  filterWrites: [],
  calls: 0,
};

function fakePi() {
  return {
    plugin: { id: 'local.pi-session-filter', version: '0.3.0' },
    slots: { register: () => () => {} },
    composer: { subscribeDraft: () => () => {} },
    ui: {
      injectStyle: (css) => {
        state.injectedCss.push(css);
        return () => {};
      },
      openLayer: () => ({ element: null, close: () => {} }),
    },
    dispatch: async (action, payload) => {
      state.calls += 1;
      if (action !== 'plugin.call') throw new Error(`unexpected action ${action}`);
      if (payload?.method === 'getConfig') return { ...state.config };
      if (payload?.method === 'setFilters') {
        state.filterWrites.push(payload.args?.filters);
        state.config = { ...state.config, filters: payload.args?.filters };
        return { filters: payload.args?.filters };
      }
      throw new Error(`unexpected method: ${payload?.method}`);
    },
  };
}

const rowEl = (id) => document.querySelector(`[data-sidebar-session-row="${id}"]`);
const isHidden = (id) => rowEl(id)?.getAttribute(ATTR) === HIDDEN;
const computed = (id) => dom.window.getComputedStyle(rowEl(id)).display;
const headerEl = (text) =>
  Array.from(document.querySelectorAll('.sidebar-time-group-header')).find(
    (element) => element.textContent.trim() === text,
  );
const headerHidden = (text) => headerEl(text)?.getAttribute(ATTR) === HIDDEN;
const hiddenIds = () =>
  Array.from(document.querySelectorAll(`[data-sidebar-session-row][${ATTR}="${HIDDEN}"]`)).map(
    (element) => element.getAttribute('data-sidebar-session-row'),
  );
const visibleIds = () =>
  Array.from(document.querySelectorAll('[data-sidebar-session-row]'))
    .filter((element) => element.getAttribute(ATTR) !== HIDDEN)
    .map((element) => element.getAttribute('data-sidebar-session-row'));
const styleTagText = () =>
  document.querySelector('style[data-pi-session-filter-style]')?.textContent ?? '';
const button = () => document.querySelector(`.${BUTTON_CLASS}`);
const menu = () => document.querySelector(`.${MENU_CLASS}`);
const click = (element) =>
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const option = (key) => menu()?.querySelector(`[${KEY_ATTR}="${key}"]`);
const isChecked = (key) => option(key)?.getAttribute('aria-checked') === 'true';
const setFilters = async (filters) => {
  state.config = { ...state.config, filters };
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await sleep(80);
};

console.log('\n[0] manifest, and the plugin-process side');
{
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  check('manifest points at the renderer module', manifest.renderer === 'renderer/index.mjs');
  check('renderer.extension is granted', manifest.permissions.includes('renderer.extension'));
  check('background.service is granted', manifest.permissions.includes('background.service'));
  check('a service is declared', (manifest.contributes?.services ?? []).length === 1);
  check('plugin.call is whitelisted for the renderer', manifest.rendererActions.includes('plugin.call'));
  for (const method of ['getConfig', 'setFilters']) {
    check(`${method} is whitelisted for plugin.call`, manifest.rendererCallMethods.includes(method));
  }

  const declared = new Set((manifest.contributes?.settings ?? []).map((setting) => setting.key));
  const used = Object.keys(module.__internals.DEFAULT_CONFIG);
  check(
    'every setting the renderer reads is declared in the manifest',
    used.every((key) => declared.has(key)),
    `used=${used.join(',')} declared=${[...declared].join(',')}`,
  );

  // main.js is CommonJS (the host loads it with require), so load it the same way.
  const pluginProcess = require('../main.js');
  const registered = new Map();
  const services = new Map();
  const toasts = [];
  let stored = { filters: 'desktop', hideRemote: false, hideEmptyTimeGroups: true, extraPrefixes: '' };
  globalThis.pi = {
    plugin: {
      getSettings: async () => ({ ...stored }),
      setSettings: async (partial) => {
        stored = { ...stored, ...partial };
      },
    },
    commands: {
      register: async (command) => {
        registered.set(command.id, command);
      },
      unregister: async (id) => {
        registered.delete(id);
      },
    },
    services: {
      register: (service) => {
        services.set(service.id, service);
      },
      unregister: async (id) => {
        services.delete(id);
      },
    },
    ui: {
      showToast: async (message) => {
        toasts.push(message);
      },
    },
  };

  await pluginProcess.onLoad();
  check('the toggle command is registered on load', registered.has('pi-session-filter.toggle'));
  check('the boot service is registered on load', services.has('renderer-boot'));

  const answered = await pluginProcess.onRendererCall('getConfig');
  check(
    'getConfig answers with the four settings',
    answered.filters === 'desktop' &&
      answered.hideRemote === false &&
      answered.hideEmptyTimeGroups === true &&
      answered.extraPrefixes === '',
    JSON.stringify(answered),
  );

  const refused = await pluginProcess.onRendererCall('somethingElse').then(
    () => false,
    () => true,
  );
  check('an unknown renderer method is refused', refused === true);

  const written = await pluginProcess.onRendererCall('setFilters', { filters: 'pi,week' });
  check('setFilters persists a valid set', stored.filters === 'pi,week' && written.filters === 'pi,week');
  await pluginProcess.onRendererCall('setFilters', { filters: '' });
  check('an empty set means 全部显示 and is kept', stored.filters === '');
  await pluginProcess.onRendererCall('setFilters', { filters: 'bogus' });
  check('an unknown key falls back to the default', stored.filters === 'desktop', JSON.stringify(stored));
  await pluginProcess.onRendererCall('setFilters', { filters: 'pi,pi,week' });
  check('duplicates are dropped', stored.filters === 'pi,week', JSON.stringify(stored));

  stored = { filters: 'desktop' };
  await registered.get('pi-session-filter.toggle').run();
  check('the command flips desktop to 全部显示', stored.filters === '', JSON.stringify(stored));
  await registered.get('pi-session-filter.toggle').run();
  check('and back', stored.filters === 'desktop', JSON.stringify(stored));
  check('the command reports the new state', toasts.length === 2, JSON.stringify(toasts));

  await pluginProcess.onUnload();
  check('unload unregisters the command and the service', registered.size === 0 && services.size === 0);
}

console.log('\n[1] pure decisions');
{
  const base = { filters: 'desktop', hideRemote: false, hideEmptyTimeGroups: true, extraPrefixes: '' };
  const hide = (id, bucket, over) => module.shouldHideSession(id, bucket, { ...base, ...over });

  check('an empty set hides nothing', hide(IDS.nativePiNewest, 'newest', { filters: '' }) === false);
  check('desktop hides a native Pi session', hide(IDS.nativePiNewest, 'newest') === true);
  check('desktop keeps a desktop session', hide(IDS.desktopNewest, 'newest') === false);
  check('desktop hides a remote session sitting in an unchecked bucket', hide(IDS.remote14d, 'fortnight') === true);
  check('hideRemote hides a remote session', hide(IDS.remote14d, 'fortnight', { hideRemote: true }) === true);
  check('hideRemote still applies under 全部显示', hide(IDS.remote14d, 'fortnight', { filters: '', hideRemote: true }) === true);
  check('pi hides a desktop session', hide(IDS.desktopNewest, 'newest', { filters: 'pi' }) === true);
  check('pi keeps a native Pi session', hide(IDS.nativePiNewest, 'newest', { filters: 'pi' }) === false);
  check('a time key keeps every source', hide(IDS.nativePiNewest, 'newest', { filters: 'newest' }) === false);
  check('a time key drops the buckets that are not checked', hide(IDS.desktopOlder, 'archived', { filters: 'week' }) === true);
  check('a time key keeps the bucket that is checked', hide(IDS.desktop14d, 'fortnight', { filters: 'fortnight' }) === false);
  check('a remote row follows the time keys', hide(IDS.remote14d, 'fortnight', { filters: 'fortnight' }) === false);
  check('two keys are a union (source)', hide(IDS.nativePiWeek1, 'week', { filters: 'pi,fortnight' }) === false);
  check('two keys are a union (time)', hide(IDS.desktop14d, 'fortnight', { filters: 'pi,fortnight' }) === false);
  check('two keys still hide what matches neither', hide(IDS.desktopOlder, 'archived', { filters: 'pi,fortnight' }) === true);
  check('a row with no bucket follows its source only', hide(IDS.pinnedNativePi, undefined, { filters: 'pi' }) === false);
  check('a row with no bucket is hidden when its source is unchecked', hide(IDS.desktopNewest, undefined, { filters: 'pi' }) === true);
  check('extraPrefixes always wins', hide(IDS.desktopNewest, 'newest', { filters: '', extraPrefixes: 'b0a048aa' }) === true);
  check('empty id is kept', hide('', 'newest') === false);

  check('a zh-CN week header is recognised', module.__internals.bucketOf('近 7 天') === 'week');
  check('an en 14-day header is recognised', module.__internals.bucketOf('Previous 14 days') === 'fortnight');
  check('an unrelated header is not', module.__internals.bucketOf('近期') === null);
  check('yesterday folds into 最新', module.__internals.checkedSummary('newest') === '最新');
  check('the summary names every checked key', module.__internals.checkedSummary('pi,week') === 'Pi 会话、近 7 天');
  check('an empty set summarises as 全部显示', module.__internals.checkedSummary('') === '全部显示');
}

console.log('\n[2] onLoad with the default filter set (PI-Desktop sessions only)');
await module.onLoad(fakePi());
await sleep(200);
{
  const styleTag = document.querySelector('style[data-pi-session-filter-style]');
  check('the module mounts its own global stylesheet', styleTag !== null);
  check(
    'the stylesheet hides the marked rows',
    Boolean(styleTag) &&
      styleTag.textContent.includes(`[${ATTR}="${HIDDEN}"]`) &&
      styleTag.textContent.includes('display: none !important'),
  );
  check('the stylesheet is not wrapped in @scope', Boolean(styleTag) && !styleTag.textContent.includes('@scope'));
  check(
    'it does not go through the host injectStyle (which scopes CSS to the plugin subtree)',
    state.injectedCss.length === 0,
    `injectStyle calls=${state.injectedCss.length}`,
  );
  check('a hidden row really computes to display:none', computed(IDS.nativePiNewest) === 'none', computed(IDS.nativePiNewest));
  check('a visible row does not compute to display:none', computed(IDS.desktopNewest) !== 'none', computed(IDS.desktopNewest));

  check('a desktop session stays visible', isHidden(IDS.desktopNewest) === false);
  check('a standalone desktop session stays visible', isHidden(IDS.standaloneDesktop) === false);
  check('a remote session in an unchecked bucket is hidden', isHidden(IDS.remote14d) === true);
  check('the newest native Pi session is hidden', isHidden(IDS.nativePiNewest) === true);
  check('a pinned native Pi session is hidden', isHidden(IDS.pinnedNativePi) === true);
  check('all 6 rows outside the default filter are hidden', hiddenIds().length === 6, `hidden=${hiddenIds().length}`);

  document.body.insertAdjacentHTML(
    'beforeend',
    row('native-pi:88888888-8888-4888-8888-888888888888', '侧边栏之外', 'native-pi'),
  );
  await sleep(200);
  check('a row outside the sidebar is left alone', isHidden('native-pi:88888888-8888-4888-8888-888888888888') === false);
}

console.log('\n[3] time headers with nothing left under them');
{
  check('"近 7 天" is hidden (only native Pi sessions)', headerHidden('近 7 天') === true);
  check('"近 14 天" stays visible', headerHidden('近 14 天') === false);
  check('"更早" stays visible', headerHidden('更早') === false);
}

console.log('\n[4] the filter button in the project header');
{
  const header = document.querySelector('.sidebar-session-group-header');
  const title = header.querySelector('.sidebar-session-group-title');
  check('exactly one button was injected', document.querySelectorAll(`.${BUTTON_CLASS}`).length === 1);
  check('it sits right after the project title', title.nextElementSibling === button());
  check('it is inside the project header', header.contains(button()) === true);
  check('it announces a menu', button().getAttribute('aria-haspopup') === 'menu');
  check('it is marked active while a filter is on', button().getAttribute('data-pi-filter-active') === 'true');
  check('it carries an icon', button().querySelector('svg') !== null);
  const icon = button().querySelector('svg');
  check(
    'the icon is drawn like the host icons (24 box, 2px stroke)',
    icon.getAttribute('viewBox') === '0 0 24 24' && icon.getAttribute('stroke-width') === '2',
  );
  check(
    'the button stays hidden until the header is hovered',
    styleTagText().includes('.sidebar-session-group-header:hover') &&
      styleTagText().includes(`.${BUTTON_CLASS}[data-pi-filter-active="true"]`),
  );
  check(
    'the button borrows the host theme tokens',
    styleTagText().includes('var(--ds-text-muted') && styleTagText().includes('var(--ds-bg-hover'),
  );
  check('its tooltip names the current filter', button().title === '过滤会话：PI-Desktop 原生会话', button().title);
  check('it is not the host own "+" button', button().className !== 'sidebar-session-group-add');
}

console.log('\n[5] the filter menu is a checkbox list');
{
  check('the menu starts closed', menu() === null);
  click(button());
  await sleep(20);
  check('clicking the button opens the menu', menu() !== null);
  check(
    'the menu carries the host popover styling',
    menu().classList.contains('sidebar-popover') && menu().classList.contains('sidebar-floating-menu'),
  );
  check('the menu is titled', menu().querySelector('.sidebar-popover-title')?.textContent === '过滤会话');

  const keys = Array.from(menu().querySelectorAll(`[${KEY_ATTR}]`)).map((element) =>
    element.getAttribute(KEY_ATTR),
  );
  check(
    'it lists 全部显示, the two sources, then the four time buckets',
    keys.join('|') === '|desktop|pi|newest|week|fortnight|older',
    keys.join('|'),
  );
  check('it draws two group dividers', menu().querySelectorAll('.sidebar-popover-divider').length === 2);
  const divider = menu().querySelector('.sidebar-popover-divider');
  check(
    'the divider is a real 1px line, not the host 6px spacer',
    dom.window.getComputedStyle(divider).height === '1px',
    dom.window.getComputedStyle(divider).height,
  );
  check('every entry is a checkbox', menu().querySelectorAll('[role="menuitemcheckbox"]').length === 7);
  check('the first group holds only 全部显示', option('')?.textContent.startsWith('全部显示'));
  check('全部显示 is unchecked while a filter is on', isChecked('') === false);
  check('PI-Desktop 原生会话 is checked', isChecked('desktop') === true);
  check('the check mark uses the host class', option('desktop')?.querySelector('.sidebar-sort-check')?.textContent === '✓');
  check('the other entries are unchecked', isChecked('pi') === false && isChecked('older') === false);

  click(option(''));
  await sleep(80);
  check('picking 全部显示 keeps the menu open', menu() !== null);
  check('全部显示 is now checked', isChecked('') === true);
  check('PI-Desktop 原生会话 was unchecked', isChecked('desktop') === false);
  check('nothing is hidden in 全部显示', hiddenIds().length === 0, `hidden=${hiddenIds().length}`);
  check('a previously hidden row is visible again', computed(IDS.nativePiNewest) !== 'none', computed(IDS.nativePiNewest));
  check('the mode was written back to the plugin', state.filterWrites.includes(''), JSON.stringify(state.filterWrites));
  check('the button is no longer marked active', button().getAttribute('data-pi-filter-active') === 'false');

  click(option('pi'));
  await sleep(60);
  check('ticking Pi 会话 unchecks 全部显示', isChecked('') === false && isChecked('pi') === true);
  check('the menu stays open', menu() !== null);
  check('native Pi rows are visible', isHidden(IDS.nativePiNewest) === false);
  check('desktop rows are hidden', isHidden(IDS.desktopNewest) === true);
  check('the filter was written back', state.filterWrites.at(-1) === 'pi', JSON.stringify(state.filterWrites));

  click(option('week'));
  await sleep(60);
  check('two boxes can be ticked at once', isChecked('pi') === true && isChecked('week') === true);
  check('a Pi row in the 7-day bucket is visible', isHidden(IDS.nativePiWeek1) === false);
  check('a desktop row in the 7-day bucket is visible too (union)', isHidden(IDS.nativePiWeek1) === false);
  check('a desktop row outside both is hidden', isHidden(IDS.desktopOlder) === true);
  check('the written set holds both keys', state.filterWrites.at(-1) === 'pi,week', state.filterWrites.at(-1));

  click(option('pi'));
  click(option('week'));
  await sleep(60);
  check('unchecking the last box re-checks 全部显示', isChecked('') === true);
  check('nothing is hidden again', hiddenIds().length === 0, `hidden=${hiddenIds().length}`);

  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(20);
  check('Escape closes the menu', menu() === null);
  check('the button reports collapsed', button().getAttribute('aria-expanded') === 'false');
}

console.log('\n[6] combinations driven from the plugin settings');
{
  await setFilters('newest');
  check('最新 keeps the newest bucket', isHidden(IDS.desktopNewest) === false && isHidden(IDS.nativePiNewest) === false);
  check('最新 hides the 7-day bucket', isHidden(IDS.nativePiWeek1) === true);
  check('最新 hides the 14-day bucket', isHidden(IDS.desktop14d) === true && isHidden(IDS.remote14d) === true);
  check('最新 hides the older bucket', isHidden(IDS.desktopOlder) === true);
  check('the emptied headers are hidden', headerHidden('近 7 天') === true && headerHidden('近 14 天') === true && headerHidden('更早') === true);

  await setFilters('older');
  check('更早 keeps only the archived bucket', visibleIds().includes(IDS.desktopOlder) === true);
  check('更早 hides the newest bucket', isHidden(IDS.desktopNewest) === true);

  await setFilters('pi,fortnight');
  check(
    'pi,fortnight shows the union',
    isHidden(IDS.nativePiWeek1) === false &&
      isHidden(IDS.desktop14d) === false &&
      isHidden(IDS.remote14d) === false &&
      isHidden(IDS.desktopNewest) === true &&
      isHidden(IDS.desktopOlder) === true,
    JSON.stringify(visibleIds()),
  );

  await setFilters('');
  check('an empty set shows everything', hiddenIds().length === 0, `hidden=${hiddenIds().length}`);
}

console.log('\n[7] rows that appear after load');
{
  await setFilters('desktop');
  document
    .querySelector('.sidebar-session-group-list')
    .insertAdjacentHTML('afterbegin', row('native-pi:66666666-6666-4666-8666-666666666666', '新出现的 Pi 会话', 'native-pi'));
  await sleep(200);
  check('a native Pi row added later is hidden', isHidden('native-pi:66666666-6666-4666-8666-666666666666') === true);
  check('the new row joins the 6 already hidden', hiddenIds().length === 7, `hidden=${hiddenIds().length}`);
}

console.log('\n[8] onUnload');
await module.onUnload();
{
  check('no marker attribute is left behind', document.querySelectorAll(`[${ATTR}]`).length === 0);
  check('no filter button is left behind', document.querySelectorAll(`.${BUTTON_CLASS}`).length === 0);
  check('no menu is left behind', menu() === null);
  check('the mounted stylesheet was removed', document.querySelector('style[data-pi-session-filter-style]') === null);
  document
    .querySelector('.sidebar-session-group-list')
    .insertAdjacentHTML('afterbegin', row('native-pi:77777777-7777-4777-8777-777777777777', '卸载后新增', 'native-pi'));
  await sleep(200);
  check('nothing is hidden after unload', hiddenIds().length === 0);
  check('no button is re-injected after unload', document.querySelectorAll(`.${BUTTON_CLASS}`).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
dom.window.close();
process.exit(failed === 0 ? 0 : 1);
