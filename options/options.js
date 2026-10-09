/** Resolve a localized message and substitute {1}, {2}, … tokens. */
function t(key, ...subs) {
  let text = chrome.i18n.getMessage(key) || key;
  for (let i = 0; i < subs.length; i++) {
    text = text.split('{' + (i + 1) + '}').join(String(subs[i]));
  }
  return text;
}

function localize() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.title = t('optionsTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

const tokenEl = document.getElementById('token');
const statusEl = document.getElementById('status');

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = 'status' + (kind ? ' status--' + kind : '');
}

async function init() {
  localize();
  const { ghToken } = await chrome.storage.local.get('ghToken');
  if (ghToken) tokenEl.value = ghToken;
}

document.getElementById('save').addEventListener('click', async () => {
  const ghToken = tokenEl.value.trim();
  await chrome.storage.local.set({ ghToken });
  setStatus(t(ghToken ? 'optSaved' : 'optCleared'), 'ok');
});

document.getElementById('clear').addEventListener('click', async () => {
  tokenEl.value = '';
  await chrome.storage.local.set({ ghToken: '' });
  setStatus(t('optCleared'), 'ok');
});

document.getElementById('test').addEventListener('click', async () => {
  setStatus(t('optTesting'), '');
  const token = tokenEl.value.trim();
  try {
    const headers = { Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch('https://api.github.com/rate_limit', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const core = data.resources && data.resources.core;
    setStatus(t('optTestOk', core ? core.remaining : '?', core ? core.limit : '?'), 'ok');
  } catch (err) {
    setStatus(t('optTestFail', err.message), 'err');
  }
});

init();
