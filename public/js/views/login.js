/** Login view — default account admin / admin123 (see server/auth.js). */
import { api, setAuth, ApiError } from '../api.js';
import { el, h } from '../util.js';
import { logoMark } from '../icons.js';

export default async function render(app) {
  app.innerHTML = '';
  const wrap = h('div', { class: 'login-wrap' });
  const card = h('div', { class: 'login-card glass' },
    el(`<span class="logo-big" style="display:block">${logoMark(58)}</span>`),
    h('h1', { html: 'Welcome to <span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">DataForge</span>' }),
    h('p', { class: 'tag', text: 'Your custom tables, formulas, forms & charts — in one place.' }),
    h('div', { class: 'login-err', id: 'login-err' }),
    h('div', { class: 'field' },
      h('label', { text: 'Username' }),
      h('input', { type: 'text', id: 'df-user', autocomplete: 'username', placeholder: 'admin', value: 'admin' }),
    ),
    h('div', { class: 'field' },
      h('label', { text: 'Password' }),
      h('input', { type: 'password', id: 'df-pass', autocomplete: 'current-password', placeholder: '••••••••', value: 'admin123' }),
    ),
    h('button', { class: 'btn primary lg', id: 'df-login-btn', style: { width: '100%' } },
      'Sign in'),
    h('div', { class: 'demo', html: 'Demo credentials — user: <b>admin</b> · password: <b>admin123</b>' }),
    h('button', { class: 'login-help', onclick: async () => { const { openHelp } = await import('../help.js'); openHelp({ topic: 'sign-in' }); } },
      'Need help? Open the how-to guide',
    ),
  );
  wrap.append(card);
  app.append(wrap);

  const errEl = card.querySelector('#login-err');
  const btn = card.querySelector('#df-login-btn');
  const doLogin = async () => {
    const username = card.querySelector('#df-user').value.trim();
    const password = card.querySelector('#df-pass').value;
    if (!username || !password) { errEl.textContent = 'Enter a username and password.'; return; }
    errEl.textContent = '';
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Signing in…';
    try {
      const { token, user } = await api.login(username, password);
      setAuth(token, user);
      location.hash = '#/';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Sign in';
      errEl.textContent = e instanceof ApiError ? e.message : 'Login failed';
    }
  };
  btn.addEventListener('click', doLogin);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  setTimeout(() => card.querySelector('#df-user').focus(), 60);
}
