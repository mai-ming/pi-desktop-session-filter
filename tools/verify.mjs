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
const ACTION_ATTR = 'data-pi-filter-action';

// The project keys the fixture renders: the host's own data-sidebar-project-group.
const PROJECT_A = 'D:/Downloads/中文核心_ADRC微操作力控';
const PROJECT_B = 'D:/Downloads/我的第二个项目';

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
  config: {
    filters: 'desktop',
    projectFilters: '{}',
    hideRemote: false,
    hideEmptyTimeGroups: true,
    extraPrefixes: '',
  },
  injectedCss: [],
  filterWrites: [],
  configWrites: [],
  calls: 0,
};

function fakePi() {
  return {
    plugin: { id: 'local.pi-session-filter', version: '0.4.0' },
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
      if (payload?.method === 'setConfig') {
        const args = payload.args ?? {};
        const next = { ...state.config };
        if (typeof args.filters === 'string') next.filters = args.filters;
        if (typeof args.projectFilters === 'string') next.projectFilters = args.projectFilters;
        state.config = next;
        state.configWrites.push(args);
        return { ...next };
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
const buttonOf = (projectKey) =>
  Array.from(document.querySelectorAll(`.${BUTTON_CLASS}`)).find(
    (element) => element.closest('.sidebar-session-group')?.getAttribute('data-sidebar-project-group') === projectKey,
  );
const menu = () => document.querySelector(`.${MENU_CLASS}`);
const menuTitle = () => menu()?.querySelector('.sidebar-popover-title')?.textContent ?? '';
const click = (element) =>
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const option = (key) => menu()?.querySelector(`[${KEY_ATTR}="${key}"]`);
const isChecked = (key) => option(key)?.getAttribute('aria-checked') === 'true';
const actionRow = (name) => menu()?.querySelector(`[${ACTION_ATTR}="${name}"]`);
const projectSets = () => JSON.parse(state.config.projectFilters);
// Drive the plugin settings the way the plugin process would hand them over.
const setConfigState = async (patch) => {
  state.config = { ...state.config, ...patch };
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await sleep(80);
};
const setFilters = (filters) => setConfigState({ filters });

console.log('\n[0] manifest, and the plugin-process side');
{
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  check('manifest points at the renderer module', manifest.renderer === 'renderer/index.mjs');
  check('renderer.extension is granted', manifest.permissions.includes('renderer.extension'));
  check('background.service is granted', manifest.permissions.includes('background.service'));
  check('a service is declared', (manifest.contributes?.services ?? []).length === 1);
  check('plugin.call is whitelisted for the renderer', manifest.rendererActions.includes('plugin.call'));
  for (const method of ['getConfig', 'setFilters', 'setConfig']) {
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
  let stored = {
    filters: 'desktop',
    projectFilters: '{}',
    hideRemote: false,
    hideEmptyTimeGroups: true,
    extraPrefixes: '',
  };
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
    'getConfig answers with the five settings',
    answered.filters === 'desktop' &&
      answered.projectFilters === '{}' &&
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

  const both = await pluginProcess.onRendererCall('setConfig', {
    filters: 'pi',
    projectFilters: '{"D:/p":"week","D:/q":""}',
  });
  check(
    'setConfig writes the default and the project sets together',
    stored.filters === 'pi' && stored.projectFilters === '{"D:/p":"week","D:/q":""}',
    JSON.stringify(stored),
  );
  check('and answers with what it stored', both.projectFilters === '{"D:/p":"week","D:/q":""}');
  check(
    'the default set survives a setConfig that only carries project sets',
    both.filters === 'pi',
    JSON.stringify(both),
  );
  await pluginProcess.onRendererCall('setConfig', { projectFilters: 'not json' });
  check('a malformed project map falls back to none', stored.projectFilters === '{}', stored.projectFilters);
  await pluginProcess.onRendererCall('setConfig', { projectFilters: '{"D:/x":"bogus","D:/y":7,"":"pi"}' });
  check(
    'a bad value becomes the default set, and non-string or empty keys are dropped',
    stored.projectFilters === '{"D:/x":"desktop"}',
    stored.projectFilters,
  );
  await pluginProcess.onRendererCall('setConfig', { projectFilters: '[]' });
  check('an array is not a project map', stored.projectFilters === '{}', stored.projectFilters);

  stored = { filters: 'desktop' };
  await registered.get('pi-session-filter.toggle').run();
  check('the command flips the default from desktop to 全部显示', stored.filters === '', JSON.stringify(stored));
  await registered.get('pi-session-filter.toggle').run();
  check('and back', stored.filters === 'desktop', JSON.stringify(stored));
  check('the command reports the new state', toasts.length === 2, JSON.stringify(toasts));
  check(
    'the command says it moved the default, not a project',
    toasts.every((message) => message.startsWith('默认：')),
    JSON.stringify(toasts),
  );

  await pluginProcess.onUnload();
  check('unload unregisters the command and the service', registered.size === 0 && services.size === 0);
}

console.log('\n[1] pure decisions');
{
  const base = {
    filters: 'desktop',
    projectFilters: {},
    hideRemote: false,
    hideEmptyTimeGroups: true,
    extraPrefixes: '',
  };
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

  check(
    'shouldHideSession judges the set it is handed',
    module.shouldHideSession(IDS.nativePiNewest, 'newest', base, 'pi') === false &&
      module.shouldHideSession(IDS.nativePiNewest, 'newest', base, 'desktop') === true,
  );
  check('the default set is used when no set is passed', module.shouldHideSession(IDS.nativePiNewest, 'newest', base) === true);

  check('a zh-CN week header is recognised', module.__internals.bucketOf('近 7 天') === 'week');
  check('an en 14-day header is recognised', module.__internals.bucketOf('Previous 14 days') === 'fortnight');
  check('an unrelated header is not', module.__internals.bucketOf('近期') === null);
  check('yesterday folds into 最新', module.__internals.checkedSummary('newest') === '最新');
  check('the summary names every checked key', module.__internals.checkedSummary('pi,week') === 'Pi 会话、近 7 天');
  check('an empty set summarises as 全部显示', module.__internals.checkedSummary('') === '全部显示');

  check('a filter set is normalised to the menu order', module.normalizeFilters('week,pi') === 'week,pi');
  check('duplicates and unknown keys are dropped', module.normalizeFilters('pi,pi,bogus') === 'pi');
  check('全部显示 survives normalisation as an empty set', module.normalizeFilters('') === '');
  check('an unreadable set becomes the default', module.normalizeFilters('bogus') === 'desktop');

  const sets = module.parseProjectFilters('{"D:/a":"pi","D:/b":""}');
  check('a project map parses', sets['D:/a'] === 'pi' && sets['D:/b'] === '');
  check('a malformed project map parses to none', Object.keys(module.parseProjectFilters('nope')).length === 0);
  check('an array is not a project map', Object.keys(module.parseProjectFilters('[1,2]')).length === 0);
  check('an empty string is an empty project map', Object.keys(module.parseProjectFilters('')).length === 0);
  check('non-string values are dropped', Object.keys(module.parseProjectFilters('{"D:/a":7}')).length === 0);
  check('project values are normalised like the default set', module.parseProjectFilters('{"k":"pi,pi,bogus"}').k === 'pi');
  check('the stored form sorts its keys', module.stringifyProjectFilters({ b: 'pi', a: 'desktop' }) === '{"a":"desktop","b":"pi"}');

  const withSets = { ...base, projectFilters: sets };
  check('a project with its own set uses it', module.filtersForProject(withSets, 'D:/a') === 'pi');
  check('an empty set is still a set: that project shows everything', module.filtersForProject(withSets, 'D:/b') === '');
  check('a project without a set follows the default', module.filtersForProject(withSets, 'D:/c') === 'desktop');
  check('a row outside every project follows the default', module.filtersForProject(withSets, null) === 'desktop');
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
  check('the second project is filtered by the same default', isHidden(IDS.secondProjectDesktop1) === false);
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
  check('one button per project, and no more', document.querySelectorAll(`.${BUTTON_CLASS}`).length === 2);
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
  check(
    'its tooltip names the project and the current filter',
    button().title === `过滤会话（中文核心_ADRC微操作力控）：PI-Desktop 原生会话`,
    button().title,
  );
  check('the two projects keep their own buttons', button() !== buttonOf(PROJECT_B));
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
  check(
    'the menu is titled with the project it belongs to',
    menuTitle().startsWith('过滤会话 · 中文核心_ADRC微操作力控'),
    menuTitle(),
  );
  check('a project with no set of its own says it follows the default', menuTitle().includes('（跟随默认）'), menuTitle());

  const keys = Array.from(menu().querySelectorAll(`[${KEY_ATTR}]`)).map((element) =>
    element.getAttribute(KEY_ATTR),
  );
  check(
    'it lists 全部显示, the two sources, then the four time buckets',
    keys.join('|') === '|desktop|pi|newest|week|fortnight|older',
    keys.join('|'),
  );
  check('it draws three dividers', menu().querySelectorAll('.sidebar-popover-divider').length === 3);
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
  check('the menu offers the two set actions', menu().querySelectorAll(`[${ACTION_ATTR}]`).length === 2);
  check('an action row is not a checkbox', actionRow('all')?.getAttribute('role') === 'menuitem');

  click(option(''));
  await sleep(80);
  check('picking 全部显示 keeps the menu open', menu() !== null);
  check('全部显示 is now checked', isChecked('') === true);
  check('PI-Desktop 原生会话 was unchecked', isChecked('desktop') === false);
  check('that project hides nothing in 全部显示', isHidden(IDS.nativePiNewest) === false && isHidden(IDS.desktopNewest) === false);
  check('a previously hidden row is visible again', computed(IDS.nativePiNewest) !== 'none', computed(IDS.nativePiNewest));
  check('rows outside every project still follow the default', isHidden(IDS.pinnedNativePi) === true);
  check('the set was written for that project alone', projectSets()[PROJECT_A] === '', state.config.projectFilters);
  check('the default set was left alone', state.config.filters === 'desktop', state.config.filters);
  check('the other project was left alone', projectSets()[PROJECT_B] === undefined);
  check('the button is no longer marked active', button().getAttribute('data-pi-filter-active') === 'false');
  check('the menu no longer claims it follows the default', !menuTitle().includes('（跟随默认）'), menuTitle());

  click(option('pi'));
  await sleep(60);
  check('ticking Pi 会话 unchecks 全部显示', isChecked('') === false && isChecked('pi') === true);
  check('the menu stays open', menu() !== null);
  check('native Pi rows are visible', isHidden(IDS.nativePiNewest) === false);
  check('desktop rows are hidden', isHidden(IDS.desktopNewest) === true);
  check('the set was written back for that project', projectSets()[PROJECT_A] === 'pi', state.config.projectFilters);
  check('the other project is still untouched', projectSets()[PROJECT_B] === undefined);

  click(option('week'));
  await sleep(60);
  check('two boxes can be ticked at once', isChecked('pi') === true && isChecked('week') === true);
  check('a Pi row in the 7-day bucket is visible', isHidden(IDS.nativePiWeek1) === false);
  check('a desktop row in the 7-day bucket is visible too (union)', isHidden(IDS.nativePiWeek1) === false);
  check('a desktop row outside both is hidden', isHidden(IDS.desktopOlder) === true);
  check('the written set holds both keys', projectSets()[PROJECT_A] === 'pi,week', state.config.projectFilters);

  click(option('pi'));
  click(option('week'));
  await sleep(60);
  check('unchecking the last box re-checks 全部显示', isChecked('') === true);
  check('nothing in that project is hidden again', isHidden(IDS.nativePiNewest) === false && isHidden(IDS.desktopNewest) === false);
  check('the second project still follows the default', isHidden(IDS.secondProjectDesktop1) === false);

  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(20);
  check('Escape closes the menu', menu() === null);
  check('the button reports collapsed', button().getAttribute('aria-expanded') === 'false');
}

console.log('\n[6] combinations driven from the plugin settings');
{
  // Back to a single set for everyone: this block is about the default.
  await setConfigState({ projectFilters: '{}' });

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

console.log('\n[8] one filter set per project');
{
  await setConfigState({ filters: 'desktop', projectFilters: '{}' });
  check('a clean slate hides 7 rows', hiddenIds().length === 7, `hidden=${hiddenIds().length}`);

  click(buttonOf(PROJECT_B));
  await sleep(20);
  check('the second project opens its own menu', menuTitle().includes('我的第二个项目'), menuTitle());
  check('its boxes start from the set it inherits', isChecked('desktop') === true && isChecked('pi') === false);
  click(option('pi'));
  await sleep(60);
  check('ticking a box builds on the inherited set', projectSets()[PROJECT_B] === 'desktop,pi', state.config.projectFilters);
  click(option('desktop'));
  await sleep(60);
  check('the set is filed under that project key', projectSets()[PROJECT_B] === 'pi', state.config.projectFilters);
  check('that project now hides its desktop sessions', isHidden(IDS.secondProjectDesktop1) === true && isHidden(IDS.secondProjectDesktop2) === true);
  check('the other project still shows them', isHidden(IDS.desktopNewest) === false);
  check('the other project still hides its Pi sessions', isHidden(IDS.nativePiNewest) === true);
  check('the other project has no set of its own', projectSets()[PROJECT_A] === undefined);
  check(
    'the other project button still reports the default set',
    buttonOf(PROJECT_A).title === '过滤会话（中文核心_ADRC微操作力控）：PI-Desktop 原生会话',
    buttonOf(PROJECT_A).title,
  );

  click(option(''));
  await sleep(80);
  check('全部显示 inside one project shows everything there', isHidden(IDS.secondProjectDesktop1) === false);
  check('an empty set is stored for that project', projectSets()[PROJECT_B] === '', state.config.projectFilters);
  check('the other project is unaffected', isHidden(IDS.nativePiNewest) === true && projectSets()[PROJECT_A] === undefined);

  click(actionRow('default'));
  await sleep(80);
  check('跟随默认 drops that project set', state.config.projectFilters === '{}', state.config.projectFilters);
  check('and the project falls back to the default', isHidden(IDS.secondProjectDesktop1) === false && isHidden(IDS.nativePiNewest) === true);
  check('the menu says it follows the default again', menuTitle().includes('（跟随默认）'), menuTitle());

  // The other direction: an empty default, one project with a set of its own.
  await setConfigState({ filters: '', projectFilters: '{}' });
  check('an empty default hides nothing anywhere', hiddenIds().length === 0, `hidden=${hiddenIds().length}`);
  click(buttonOf(PROJECT_A));
  await sleep(20);
  click(option('pi'));
  await sleep(80);
  check('a single project can be the only filtered one', isHidden(IDS.desktopNewest) === true && isHidden(IDS.nativePiNewest) === false);
  check('every other project keeps showing everything', isHidden(IDS.secondProjectDesktop2) === false && isHidden(IDS.standaloneDesktop) === false);
  check('the pinned section follows the default too', isHidden(IDS.pinnedNativePi) === false);

  click(actionRow('all'));
  await sleep(80);
  check('应用到全部项目 moves the set into the default', state.config.filters === 'pi', state.config.filters);
  check('and clears the per-project sets', state.config.projectFilters === '{}', state.config.projectFilters);
  check('so every project hides desktop sessions now', isHidden(IDS.desktopNewest) === true && isHidden(IDS.secondProjectDesktop1) === true);
  check('and every project keeps its Pi sessions', isHidden(IDS.nativePiNewest) === false);

  // A remote project group carries no key attribute; its name is the key.
  document.querySelector('.sidebar-session-groups').insertAdjacentHTML(
    'beforeend',
    [
      '<section class="sidebar-session-group">',
      '<div class="sidebar-session-group-header">',
      '<button type="button" class="sidebar-session-group-title"><span>远程项目 · host-a</span></button>',
      '</div>',
      '<div class="sidebar-session-group-clip"><div class="sidebar-session-group-list">',
      row('remote:host-a:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '1008-远程', 'remote'),
      '</div></div>',
      '</section>',
    ].join(''),
  );
  await sleep(200);
  const remoteButton = Array.from(document.querySelectorAll(`.${BUTTON_CLASS}`)).find(
    (element) => !element.closest('[data-sidebar-project-group]'),
  );
  check('a group without a host key still gets a button', Boolean(remoteButton));
  click(remoteButton);
  await sleep(20);
  check('its menu names the group', menuTitle().includes('远程项目 · host-a'), menuTitle());
  click(option(''));
  await sleep(80);
  check(
    'its set is filed under the group name',
    Object.prototype.hasOwnProperty.call(projectSets(), 'title:远程项目 · host-a'),
    state.config.projectFilters,
  );
  check('its row shows up', isHidden('remote:host-a:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') === false);
  check('the projects are untouched by it', isHidden(IDS.desktopNewest) === true && isHidden(IDS.secondProjectDesktop1) === true);
}

console.log('\n[9] onUnload');
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
