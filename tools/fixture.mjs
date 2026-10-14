// Sidebar markup mirroring PI-Desktop 0.20.1.
//
// Source of truth: app.asar → out/renderer/assets/index-*.js (sidebar component).
//   section.sidebar-session-group.project-group[data-sidebar-project-group]
//     div.sidebar-session-group-header
//       button.sidebar-session-group-title        ← the project name
//       span.sr-only, div.sidebar-menu-wrap, button.sidebar-session-group-add
//     div.sidebar-session-group-clip
//       div.sidebar-session-group-list
//         div.sidebar-time-group-header           ← omitted for the newest bucket
//         div.thread-item[data-sidebar-session-row=<session id>]
//           button.thread-item-main
//             span.thread-item-source[title="Native Pi session"]   ← native Pi only
//             span.thread-item-source[title=<host>]                ← remote only
//             span.thread-item-title
//           div.sidebar-row-actions
//
// Row ids are the host's own session ids: desktop sessions are uuids, native Pi
// sessions start with "native-pi:", remote sessions with "remote:".

export const IDS = {
  desktopNewest: 'b0a048aa-1b9f-4cec-9765-398c1aecd545',
  nativePiNewest: 'native-pi:11111111-1111-4111-8111-111111111111',
  nativePiWeek1: 'native-pi:22222222-2222-4222-8222-222222222222',
  nativePiWeek2: 'native-pi:33333333-3333-4333-8333-333333333333',
  nativePiWeek3: 'native-pi:44444444-4444-4444-8444-444444444444',
  desktop14d: '33750530-3452-41c5-b6de-99780679e4cf',
  remote14d: 'remote:host-a:9a167ea8-b875-467f-b250-ea3c8e9c2d73',
  desktopOlder: '2e42d7ab-f78f-4799-b9a3-c3bc79a04e8a',
  pinnedNativePi: 'native-pi:55555555-5555-4555-8555-555555555555',
  standaloneDesktop: '1d264b3a-ba6d-45b8-8814-bd7dcdbc41ad',
};

export function row(id, title, kind = 'desktop') {
  const badge =
    kind === 'native-pi'
      ? '<span class="thread-item-source" title="Native Pi session">Pi</span>'
      : kind === 'remote'
        ? '<span class="thread-item-source" title="host-a">远程</span>'
        : '';
  return [
    `<div class="thread-item" data-sidebar-session-row="${id}">`,
    `<button type="button" class="thread-item-main">${badge}<span class="thread-item-title">${title}</span></button>`,
    '<div class="sidebar-row-actions"><button type="button" class="thread-item-more" data-action="session-menu"></button></div>',
    '</div>',
  ].join('');
}

function projectHeader(name, id) {
  return [
    '<div class="sidebar-session-group-header">',
    `<button type="button" id="${id}" class="sidebar-session-group-title project-toggle" data-action="toggle-project-collapse">`,
    '<span class="sidebar-disclosure-icon"></span><span class="sidebar-folder-icon"></span>',
    `<span>${name}</span>`,
    '</button>',
    `<span id="${id}-path-description" class="sr-only">D:/Downloads/${name}</span>`,
    '<div class="sidebar-menu-wrap"><button type="button" class="thread-item-more project-more" aria-haspopup="menu"></button></div>',
    '<button type="button" class="sidebar-session-group-add"></button>',
    '</div>',
  ].join('');
}

export function buildSidebarHtml() {
  return `<!doctype html><html><body>
<div class="app-shell">
  <aside class="sidebar-surface">
    <div class="sidebar-body no-drag">
      <section class="sidebar-pinned-sessions" data-sidebar-session-section="pinned">
        <div class="sidebar-list-toolbar sidebar-list-toolbar-secondary">
          <span id="sidebar-pinned-label" class="sidebar-list-label">置顶</span>
        </div>
        <div class="sidebar-session-group-body pinned">
          ${row(IDS.pinnedNativePi, '1012-审一', 'native-pi')}
        </div>
      </section>
      <section class="sidebar-standalone-sessions" data-sidebar-session-section="temporary">
        <div class="sidebar-list-toolbar sidebar-list-toolbar-secondary" data-sidebar-section="sessions">
          <span id="sidebar-standalone-sessions-label" class="sidebar-list-label">会话</span>
        </div>
        <div class="sidebar-session-group-body">
          ${row(IDS.standaloneDesktop, '临时对话')}
        </div>
      </section>
      <div class="sidebar-session-groups min-h-0 flex-1 overflow-auto px-0.5">
        <section class="sidebar-session-group project-group" data-sidebar-project-group="D:/Downloads/中文核心_ADRC微操作力控" data-current-workspace="true">
          ${projectHeader('中文核心_ADRC微操作力控', 'sidebar-project-group-label')}
          <div class="sidebar-session-group-clip">
            <div class="sidebar-session-group-list">
              ${row(IDS.desktopNewest, '1013-审一')}
              ${row(IDS.nativePiNewest, '1012-审一', 'native-pi')}
              <div class="sidebar-time-group-header">近 7 天</div>
              ${row(IDS.nativePiWeek1, '1011-废', 'native-pi')}
              ${row(IDS.nativePiWeek2, '1011-执行3', 'native-pi')}
              ${row(IDS.nativePiWeek3, '你是独立执行 agent, 任务名为 …', 'native-pi')}
              <div class="sidebar-time-group-header">近 14 天</div>
              ${row(IDS.desktop14d, '1008-执行二')}
              ${row(IDS.remote14d, '1008-新 (2)', 'remote')}
              <div class="sidebar-time-group-header">更早</div>
              ${row(IDS.desktopOlder, '0920-核心四轮')}
              <button type="button" class="sidebar-load-more">加载更多（3 条）…</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </aside>
</div>
</body></html>`;
}
