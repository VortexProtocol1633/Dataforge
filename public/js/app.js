/**
 * DataForge front-end bootstrap — hash router + global chrome.
 * Routes:
 *   #/login           login screen
 *   #/                dashboard (tables)
 *   #/charts          dashboard (charts tab)
 *   #/t/:tableId      table workspace
 *   #/share/:token    public read-only single-row page
 */
import { getUser, setAuth, getToken } from './api.js';
import { THEMES, currentTheme, setTheme, themeIcon } from './theme.js';
import { icon, logoMark } from './icons.js';
import { el, h, modal } from './util.js';

function parseRoute() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return { name: 'dashboard' };
  if (parts[0] === 'login') return { name: 'login' };
  if (parts[0] === 'share') return { name: 'share', token: parts[1] };
  if (parts[0] === 't') return { name: 'table', id: parts[1] };
  if (parts[0] === 'charts') return { name: 'dashboard' };
  return { name: 'dashboard' };
}

export function nav(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function chrome(active) {
  const user = getUser();
  const root = el('<div class="topbar no-print"></div>');
  const brand = h('div', { class: 'brand', onclick: () => nav('#/') },
    el(logoMark(30)),
    h('div', { class: 'wordmark', html: '<span>Data</span><span>Forge</span>' }),
  );
  const navbtn = (href, label, iconName, isActive) =>
    h('button', { class: 'navbtn' + (isActive ? ' active' : ''), onclick: () => nav(href) },
      el(icon(iconName, 15)), h('span', { class: 'lbl', text: label }));
  const showCharts = active === 'charts';
  const navbtns = h('nav', { class: 'topnav' },
    navbtn('#/', 'Tables', 'grid', !showCharts),
    navbtn('#/charts', 'Charts', 'chart', showCharts),
  );
  const aboutBtn = h('button', {
    class: 'navbtn', title: 'About DataForge', html: `${icon('info', 15)} <span class="lbl">About</span>`,
    onclick: async () => {
      const { openAbout } = await import('./about.js');
      openAbout();
    },
  });
  const helpBtn = h('button', {
    class: 'navbtn helpbtn', title: 'Help & how-to guides', html: `${icon('help', 15)} <span class="lbl">Help</span>`,
    onclick: async () => {
      const { openHelp, helpTopicForRoute } = await import('./help.js');
      openHelp({ topic: helpTopicForRoute() });
    },
  });
  const themeBtn = h('button', {
    class: 'icon-btn theme-btn', title: 'Change the app theme', 'aria-label': 'Change the app theme', html: themeIcon(),
    onclick: (e) => {
      openThemePicker(e.currentTarget);
    },
  });
  const userinfo = h('div', { class: 'userinfo' },
    h('span', { class: 'avatar', text: ((user && user.username) || '?')[0].toUpperCase() }),
    h('span', { class: 'uname', text: (user && user.username) || '' }),
  );
  const menuBtn = h('button', { class: 'icon-btn', title: 'Menu', 'aria-label': 'User menu', html: icon('more') });
  root.append(brand, navbtns, h('div', { class: 'spacer' }), aboutBtn, helpBtn, themeBtn, userinfo, menuBtn);

  menuBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const { popMenu } = await import('./util.js');
    const { api } = await import('./api.js');
    popMenu(menuBtn, [
      { header: user ? user.username : 'Signed out' },
      { label: 'Log out', icon: 'logout', onClick: async () => { try { await api.logout(); } catch { /* ignore */ } setAuth(null, null); nav('#/login'); } },
    ]);
  });
  return root;
}

/** Theme picker — light/dark plus the full colour-palette themes. */
function openThemePicker(anchor) {
  const m = modal({
    title: 'App theme',
    sub: 'Repaint the entire UI — your choice is saved for next time.',
  });
  const grid = h('div', { class: 'themepick' });
  const cur = currentTheme();
  for (const t of THEMES) {
    const on = t.id === cur;
    const dots = t.colors.map((c) => `<i style="background:${c}"></i>`).join('');
    const card = h('button', {
      type: 'button',
      class: 'theme-opt' + (on ? ' sel' : ''),
      'aria-label': `Use ${t.name} theme`,
      onclick: () => {
        setTheme(t.id);
        const iconBtn = anchor && document.querySelector('.topbar .theme-btn');
        if (iconBtn) iconBtn.innerHTML = themeIcon();
        m.close();
      },
    },
      h('span', { class: 'theme-prev', style: { background: t.bg } },
        h('span', { class: 'theme-prev-bar', style: { background: `linear-gradient(135deg, ${t.colors.join(', ')})` } }),
      ),
      h('span', { class: 'nm', text: t.name }),
      h('span', { class: 'tg', text: t.desc }),
      h('span', { class: 'theme-dots', html: dots }),
      on ? h('span', { class: 'theme-cur', text: 'Active' }) : null,
    );
    grid.append(card);
  }
  m.body.append(grid);
  m.foot.append(h('button', { class: 'btn', text: 'Close', onclick: () => m.close() }));
}

async function mountView(view, content, route) {
  // No spinner here: each view renders its own labeled loading section
  // (util.loadingSection) and takes full ownership of `content`. A spinner
  // appended here would survive on views that render into a nested container
  // (e.g. the table workspace) and spin forever above the page.
  try { await view.default(content, route); }
  catch (e) {
    content.innerHTML = '';
    content.append(h('div', { class: 'glass', style: { padding: '30px', textAlign: 'center' } },
      h('h3', { text: 'Something went wrong' }),
      h('p', { class: 'muted', text: e.message || String(e) }),
    ));
    console.error(e);
  }
}

export async function render() {
  const route = parseRoute();
  const app = document.getElementById('app');
  app.innerHTML = '';
  document.getElementById('modal-root').innerHTML = '';

  // public share page renders standalone (clean for printing to PDF)
  if (route.name === 'share') {
    const view = await import('./views/share.js');
    const wrap = h('div', { class: 'share-page' });
    app.append(wrap);
    try { await view.default(wrap, route.token); }
    catch (e) { wrap.append(h('div', { class: 'glass share-card' }, h('p', { text: e.message || String(e) }))); }
    return;
  }

  // login
  if (route.name === 'login') {
    if (getToken()) { location.hash = '#/'; return; }
    const view = await import('./views/login.js');
    await view.default(app, route);
    return;
  }

  // authenticated views
  if (!getToken()) { location.hash = '#/login'; return; }
  const isCharts = location.hash.startsWith('#/charts');
  app.append(chrome(isCharts ? 'charts' : 'dashboard'));
  const content = h('div', { class: 'page' });
  app.append(content);

  let view;
  if (route.name === 'table') view = await import('./views/table.js');
  else view = await import('./views/dashboard.js');
  await mountView(view, content, route);
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);
