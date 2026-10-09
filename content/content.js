/* GitHub Folder Downloader — content script.
 *
 * Responsibilities:
 *   - Inject a "Download" button in the code view header, left of "Add file".
 *   - In selection mode, add a checkbox to every file/folder row.
 *   - Track the selection (files + folders) and package the selection into a
 *     ZIP, then trigger the browser download.
 *
 * All network + ZIP work happens here (not in the service worker) because
 * `URL.createObjectURL` is not available in MV3 service workers and the
 * GitHub API / raw endpoints are CORS-enabled for the github.com origin.
 */
(() => {
  'use strict';

  if (globalThis.__ghdlLoaded) return;
  globalThis.__ghdlLoaded = true;

  const SEL = {
    row: 'tr.react-directory-row',
    filenameColumn: '.react-directory-filename-column',
    headerWide: '.react-code-view-header-element--wide',
    headerNarrow: '.react-code-view-header-element--narrow',
  };

  const CONCURRENCY = 6;
  const SOFT_LIMIT_FILES = 200;

  const state = {
    owner: '',
    repo: '',
    ref: '',
    subdir: '',
    ctxKey: '',
    selecting: false,
    selected: new Set(), // explicit entries (files + dirs), repo-relative paths
    dirs: new Set(), // subset of `selected` that are directories
    rows: [], // [{ row, info }]
    busy: false,
    toolbar: null,
    toastEl: null,
    toastTimer: null,
  };

  // ------------------------------------------------------------------ utils

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const isUnder = (path, prefix) => path === prefix || path.startsWith(prefix + '/');
  const encodePath = (p) =>
    p
      .split('/')
      .map(encodeURIComponent)
      .join('/');

  function debounce(fn, ms) {
    let timer = 0;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // i18n: resolve a localized message and substitute {1}, {2}, … tokens.
  function msg(key, ...subs) {
    let text = key;
    try {
      text = chrome.i18n.getMessage(key) || key;
    } catch (_) {
      /* chrome.i18n unavailable — fall back to the key */
    }
    for (let i = 0; i < subs.length; i++) {
      text = text.split('{' + (i + 1) + '}').join(String(subs[i]));
    }
    return text;
  }

  // -------------------------------------------------------- repo / URL ctx

  function readCurrentRef() {
    const selectors = [
      'button.react-repos-tree-pane-ref-selector',
      '[class*="RefSelectorBtnTextContainer"] [class*="RefSelectorText"]',
      '[class*="RefSelectorText"]',
      '[data-testid="anchor-button"][class*="ref"]',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      const t = el && el.textContent ? el.textContent.trim() : '';
      if (t && t.length < 200) return t;
    }
    return '';
  }

  /**
   * Returns { owner, repo, ref, subdir } when the current page is a repository
   * code tree (root or /tree/...), otherwise null.
   */
  function parseRepoContext() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1];
    const kind = parts[2];

    if (kind === undefined) {
      // /owner/repo  → repo root (default branch)
      return { owner, repo, ref: readCurrentRef() || 'HEAD', subdir: '' };
    }
    if (kind !== 'tree') return null; // issues, pulls, blob, commits, ...

    const ref = readCurrentRef();
    const rest = parts.slice(3).join('/');
    if (ref && (rest === ref || rest.startsWith(ref + '/'))) {
      return { owner, repo, ref, subdir: rest.slice(ref.length).replace(/^\//, '') };
    }
    if (!parts[3]) return null;
    // Fallback when the ref selector isn't found: assume the first segment is the ref.
    return { owner, repo, ref: parts[3], subdir: parts.slice(4).join('/') };
  }

  // -------------------------------------------------------------- selection

  function ancestorDirSelected(path) {
    let idx = path.lastIndexOf('/');
    while (idx > 0) {
      if (state.dirs.has(path.slice(0, idx))) return true;
      idx = path.lastIndexOf('/', idx - 1);
    }
    return false;
  }

  function isFileIncluded(path) {
    return state.selected.has(path) || ancestorDirSelected(path);
  }

  function dirHasSelectedDescendant(path) {
    for (const p of state.selected) {
      if (p !== path && isUnder(p, path)) return true;
    }
    return false;
  }

  const selKey = () => `ghdl:sel:${state.owner}/${state.repo}@${state.ref}`;

  async function persistSelection() {
    try {
      if (!chrome.storage || !chrome.storage.session) return;
      await chrome.storage.session.set({
        [selKey()]: { entries: [...state.selected], dirs: [...state.dirs] },
      });
    } catch (_) {
      /* storage.session may not be exposed to content scripts — ignore */
    }
  }

  async function restoreSelection() {
    try {
      if (!chrome.storage || !chrome.storage.session) return;
      const key = selKey();
      const data = await chrome.storage.session.get(key);
      const v = data && data[key];
      if (v) {
        state.selected = new Set(v.entries || []);
        state.dirs = new Set(v.dirs || []);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function applyToggle(info, checked) {
    if (info.type === 'dir') {
      if (checked) {
        state.dirs.add(info.path);
        state.selected.add(info.path);
        for (const p of [...state.selected]) {
          if (p !== info.path && isUnder(p, info.path)) {
            state.selected.delete(p);
            state.dirs.delete(p);
          }
        }
      } else {
        state.dirs.delete(info.path);
        state.selected.delete(info.path);
        for (const p of [...state.selected]) {
          if (isUnder(p, info.path)) {
            state.selected.delete(p);
            state.dirs.delete(p);
          }
        }
      }
    } else if (checked) {
      state.selected.add(info.path);
    } else {
      state.selected.delete(info.path);
    }
  }

  // ------------------------------------------------------------- DOM wiring

  function rowInfo(row) {
    const link = row.querySelector('a[href*="/blob/"], a[href*="/tree/"]');
    if (!link) return null; // "parent directory" row or submodule row

    const href = link.getAttribute('href') || '';
    const aria = link.getAttribute('aria-label') || '';

    if (/\(submodule\)/i.test(aria)) return null; // submodules are skipped
    if (/git lfs/i.test(aria + ' ' + (row.textContent || ''))) return null; // LFS skipped

    const m = href.match(/\/(blob|tree)\//);
    if (!m) return null; // not a blob/tree link (e.g. submodule pointing elsewhere)

    const kind = m[1];
    const marker = `/${kind}/`;
    let rest = href.slice(href.indexOf(marker) + marker.length); // "{ref}/{path}"
    if (state.ref && (rest === state.ref || rest.startsWith(state.ref + '/'))) {
      rest = rest.slice(state.ref.length);
    } else {
      const i = rest.indexOf('/');
      rest = i >= 0 ? rest.slice(i) : '';
    }
    const path = decodeURIComponent(rest.replace(/^\/+|\/+$/g, ''));
    if (!path) return null;

    return { path, type: kind === 'tree' ? 'dir' : 'file' };
  }

  function addCheckbox(row, info) {
    const cols = row.querySelectorAll(SEL.filenameColumn);
    cols.forEach((col) => {
      if (col.querySelector('.ghdl-check')) return;
      const label = document.createElement('label');
      label.className = 'ghdl-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ghdl-cb';
      cb.dataset.ghdlPath = info.path;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        applyToggle(info, cb.checked);
        persistSelection();
        refreshAllRows();
      });
      label.appendChild(cb);
      col.insertBefore(label, col.firstChild);
    });
    row.classList.add('ghdl-row');
  }

  function removeCheckbox(row) {
    row.querySelectorAll('.ghdl-check').forEach((el) => el.remove());
    row.classList.remove('ghdl-row');
  }

  function renderRowState(row, info) {
    let checked = false;
    let indeterminate = false;
    let disabled = false;

    if (info.type === 'dir') {
      checked = state.dirs.has(info.path);
      indeterminate = !checked && dirHasSelectedDescendant(info.path);
    } else if (state.selected.has(info.path)) {
      checked = true;
    } else if (ancestorDirSelected(info.path)) {
      checked = true;
      disabled = true; // included because a parent folder is selected
    }

    row.querySelectorAll('input.ghdl-cb').forEach((cb) => {
      cb.checked = checked;
      cb.indeterminate = indeterminate;
      cb.disabled = disabled;
    });
  }

  function refreshAllRows() {
    const rows = document.querySelectorAll(SEL.row);
    state.rows = [];
    rows.forEach((row) => {
      const info = rowInfo(row);
      if (!info) return;
      state.rows.push({ row, info });
      if (state.selecting) addCheckbox(row, info);
      else removeCheckbox(row);
      renderRowState(row, info);
    });
    updateMaster();
  }

  function visibleIncluded(info) {
    return info.type === 'dir' ? state.dirs.has(info.path) : isFileIncluded(info.path);
  }

  function updateMaster() {
    const master = state.toolbar && state.toolbar.querySelector('.ghdl-master');
    if (!master) return;
    let included = 0;
    for (const { info } of state.rows) if (visibleIncluded(info)) included++;
    master.checked = state.rows.length > 0 && included === state.rows.length;
    master.indeterminate = included > 0 && included < state.rows.length;
  }

  // -------------------------------------------------------------- the UI

  function findActionContainer() {
    const root =
      document.querySelector(SEL.headerWide) || document.querySelector(SEL.headerNarrow);
    if (!root) return null;
    return root.querySelector('.d-flex') || root;
  }

  function findAddFileAnchor(container) {
    const candidates = container.querySelectorAll('button, a, summary');
    for (const el of candidates) {
      if ((el.textContent || '').trim().startsWith('Add file')) {
        let anchor = el;
        while (anchor && anchor.parentElement !== container) anchor = anchor.parentElement;
        return anchor || el;
      }
    }
    return null;
  }

  function buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'ghdl-toolbar';

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'ghdl-btn ghdl-btn--primary ghdl-action-download';
    downloadBtn.textContent = msg('btnDownload');
    downloadBtn.addEventListener('click', enterSelecting);

    const selectbar = document.createElement('div');
    selectbar.className = 'ghdl-selectbar';

    const masterLabel = document.createElement('label');
    masterLabel.className = 'ghdl-master-label';
    const master = document.createElement('input');
    master.type = 'checkbox';
    master.className = 'ghdl-master';
    master.addEventListener('change', (e) => onMasterChange(e.target.checked));
    masterLabel.append(master, document.createTextNode(msg('btnSelectAll')));

    const invertBtn = document.createElement('button');
    invertBtn.type = 'button';
    invertBtn.className = 'ghdl-btn ghdl-btn--sm ghdl-action-invert';
    invertBtn.textContent = msg('btnInvert');
    invertBtn.addEventListener('click', invertAll);

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'ghdl-btn ghdl-btn--primary ghdl-action-confirm';
    confirmBtn.textContent = msg('btnDownload');
    confirmBtn.addEventListener('click', startDownload);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ghdl-btn ghdl-btn--sm ghdl-action-cancel';
    cancelBtn.textContent = msg('btnCancel');
    cancelBtn.addEventListener('click', exitSelecting);

    selectbar.append(masterLabel, invertBtn, confirmBtn, cancelBtn);
    toolbar.append(downloadBtn, selectbar);
    return toolbar;
  }

  function injectToolbar(container) {
    const toolbar = buildToolbar();
    const anchor = findAddFileAnchor(container);
    if (anchor && anchor.parentElement === container) container.insertBefore(toolbar, anchor);
    else container.insertBefore(toolbar, container.firstChild);
    state.toolbar = toolbar;
    updateToolbar();
    refreshAllRows();
  }

  function updateToolbar() {
    const t = state.toolbar;
    if (!t) return;
    const download = t.querySelector('.ghdl-action-download');
    const selectbar = t.querySelector('.ghdl-selectbar');
    if (!download || !selectbar) return;

    download.style.display = state.selecting ? 'none' : '';
    selectbar.style.display = state.selecting ? '' : 'none';

    const confirm = t.querySelector('.ghdl-action-confirm');
    if (confirm) {
      const n = state.selected.size;
      confirm.textContent = n ? msg('btnDownloadCount', n) : msg('btnDownload');
      confirm.disabled = state.busy;
    }
  }

  function enterSelecting() {
    state.selecting = true;
    updateToolbar();
    refreshAllRows();
  }

  function exitSelecting() {
    state.selecting = false;
    state.selected = new Set();
    state.dirs = new Set();
    persistSelection();
    updateToolbar();
    refreshAllRows();
  }

  function onMasterChange(want) {
    for (const { info } of state.rows) {
      if (want) {
        if (!visibleIncluded(info)) applyToggle(info, true);
      } else if (info.type === 'dir') {
        if (state.dirs.has(info.path)) applyToggle(info, false);
      } else {
        state.selected.delete(info.path);
      }
    }
    persistSelection();
    refreshAllRows();
  }

  function invertAll() {
    for (const { info } of state.rows) {
      const included = info.type === 'dir' ? state.dirs.has(info.path) : isFileIncluded(info.path);
      applyToggle(info, !included);
    }
    persistSelection();
    refreshAllRows();
  }

  // ------------------------------------------------------------- download

  async function getToken() {
    try {
      const { ghToken } = await chrome.storage.local.get('ghToken');
      return ghToken || '';
    } catch (_) {
      return '';
    }
  }

  function apiHeaders(token) {
    const h = { Accept: 'application/vnd.github+json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  async function fetchWithRetry(url, options, tries = 4) {
    let lastErr;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const res = await fetch(url, options);
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          const retryAfter = Number(res.headers.get('retry-after')) || 0;
          await sleep(retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000));
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
      }
    }
    throw lastErr || new Error(msg('errNetwork'));
  }

  async function fetchTree(owner, repo, ref, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodePath(ref)}?recursive=1`;
    const res = await fetchWithRetry(url, { headers: apiHeaders(token) });
    if (res.status === 401) throw new Error(msg('errTokenInvalid'));
    if (res.status === 404) throw new Error(msg('errRepoNotFound'));
    if (res.status === 403 || res.status === 429) {
      throw new Error(msg('errRateLimit'));
    }
    if (!res.ok) throw new Error(msg('errFetchTree', res.status));
    const data = await res.json();
    if (data.truncated) throw new Error(msg('errRepoTooLarge'));
    return Array.isArray(data.tree) ? data.tree : [];
  }

  async function fetchRaw(owner, repo, ref, path, token) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodePath(ref)}/${encodePath(path)}`;
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetchWithRetry(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async function runPool(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) break;
        await worker(items[idx], idx);
      }
    });
    await Promise.all(runners);
  }

  function buildZipName() {
    const sub = state.subdir ? '-' + state.subdir.replace(/[/\\]+/g, '-') : '';
    const raw = `${state.repo}-${state.ref}${sub}.zip`;
    return raw.replace(/[^\w.\-]+/g, '_');
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function startDownload() {
    if (state.busy) return;
    if (state.selected.size === 0) {
      showToast(msg('toastSelectFirst'), 'error');
      return;
    }

    state.busy = true;
    updateToolbar();
    showToast(msg('toastPreparing'), 'progress', 0);

    try {
      const token = await getToken();
      const entries = [...state.selected];
      const hasDirs = state.dirs.size > 0;
      let filePaths = [];
      let skipped = 0;

      if (hasDirs) {
        showToast(msg('toastFetchingTree'), 'progress', null);
        const tree = await fetchTree(state.owner, state.repo, state.ref, token);
        const wanted = new Set();

        for (const p of entries) {
          if (state.dirs.has(p)) {
            const prefix = p + '/';
            for (const e of tree) {
              if (!e.path.startsWith(prefix)) continue;
              if (e.type === 'commit') {
                skipped++; // submodule
                continue;
              }
              if (e.type !== 'blob') continue;
              if (e.mode === '120000') {
                skipped++; // symlink
                continue;
              }
              if (e.path.includes('/.git/') || e.path.endsWith('/.git')) {
                skipped++;
                continue;
              }
              wanted.add(e.path);
            }
          } else {
            wanted.add(p);
          }
        }
        filePaths = [...wanted];
      } else {
        filePaths = entries.slice();
      }

      filePaths = filePaths.filter((p) => !state.dirs.has(p));
      if (!filePaths.length) throw new Error(msg('errNoFiles'));

      if (filePaths.length > SOFT_LIMIT_FILES) {
        showToast(msg('toastManyFiles', filePaths.length), 'progress', 0);
      }

      const parts = [];
      let done = 0;
      let failed = 0;

      await runPool(filePaths, CONCURRENCY, async (path) => {
        try {
          const bytes = await fetchRaw(state.owner, state.repo, state.ref, path, token);
          parts.push({ name: path, data: bytes });
        } catch (_) {
          failed++;
        } finally {
          done++;
          showToast(
            msg('toastDownloading', done, filePaths.length),
            'progress',
            (done / filePaths.length) * 100,
          );
        }
      });

      if (!parts.length) {
        throw new Error(msg('errAllFailed'));
      }

      showToast(msg('toastPackaging'), 'progress', 100);
      await nextFrame();

      if (parts.length > 65535) throw new Error(msg('errZipLimit'));
      parts.sort((a, b) => a.name.localeCompare(b.name));
      const blob = globalThis.GHDLZip.createZip(parts);
      triggerDownload(blob, buildZipName());

      let doneMsg;
      if (skipped && failed) {
        doneMsg = msg('toastDoneSkippedFailed', parts.length, skipped, failed);
      } else if (skipped) {
        doneMsg = msg('toastDoneSkipped', parts.length, skipped);
      } else if (failed) {
        doneMsg = msg('toastDoneFailed', parts.length, failed);
      } else {
        doneMsg = msg('toastDone', parts.length);
      }
      showToast(doneMsg, 'done', 100);
    } catch (err) {
      console.error('[GitHub Folder Downloader]', err);
      showToast(err && err.message ? err.message : msg('errDownloadFailed'), 'error');
    } finally {
      state.busy = false;
      updateToolbar();
    }
  }

  // ---------------------------------------------------------------- toast

  function dismissToast() {
    if (state.toastEl) {
      state.toastEl.remove();
      state.toastEl = null;
    }
  }

  function showToast(message, kind, progressPct) {
    let el = state.toastEl;
    if (!el || !el.isConnected) {
      el = document.createElement('div');
      el.className = 'ghdl-toast';
      el.innerHTML =
        '<div class="ghdl-toast__head">' +
        '<span class="ghdl-toast__title"></span>' +
        '<button type="button" class="ghdl-toast__close">×</button>' +
        '</div>' +
        '<div class="ghdl-toast__msg"></div>' +
        '<div class="ghdl-toast__bar"><div class="ghdl-toast__fill"></div></div>';
      el.querySelector('.ghdl-toast__title').textContent = msg('extName');
      el.querySelector('.ghdl-toast__close').setAttribute('aria-label', msg('a11yClose'));
      el.querySelector('.ghdl-toast__close').addEventListener('click', dismissToast);
      document.body.appendChild(el);
      state.toastEl = el;
    }

    el.dataset.kind = kind;
    el.querySelector('.ghdl-toast__msg').textContent = message;

    const bar = el.querySelector('.ghdl-toast__bar');
    const fill = el.querySelector('.ghdl-toast__fill');
    if (typeof progressPct === 'number') {
      bar.style.display = '';
      fill.style.width = Math.max(0, Math.min(100, progressPct)) + '%';
    } else {
      bar.style.display = 'none';
    }

    clearTimeout(state.toastTimer);
    if (kind === 'done') state.toastTimer = setTimeout(dismissToast, 5000);
  }

  // -------------------------------------------------------------- lifecycle

  function teardown() {
    if (state.toolbar) {
      state.toolbar.remove();
      state.toolbar = null;
    }
    document.querySelectorAll('.ghdl-check').forEach((el) => el.remove());
    document.querySelectorAll('.ghdl-row').forEach((el) => el.classList.remove('ghdl-row'));
    state.rows = [];
    state.selecting = false;
  }

  function sync() {
    const ctx = parseRepoContext();
    if (!ctx) {
      if (state.toolbar) teardown();
      return;
    }

    const ctxKey = `${ctx.owner}/${ctx.repo}@${ctx.ref}`;
    if (ctxKey !== state.ctxKey) {
      state.ctxKey = ctxKey;
      state.owner = ctx.owner;
      state.repo = ctx.repo;
      state.ref = ctx.ref;
      state.selected = new Set();
      state.dirs = new Set();
      state.selecting = false;
      restoreSelection().then(() => {
        refreshAllRows();
        updateToolbar();
      });
    }
    state.subdir = ctx.subdir;

    const container = findActionContainer();
    if (container && (!state.toolbar || !state.toolbar.isConnected)) {
      injectToolbar(container);
    }

    if (state.selecting) refreshAllRows();
    updateMaster();
    updateToolbar();
  }

  function boot() {
    const scheduleSync = debounce(() => requestAnimationFrame(sync), 100);

    new MutationObserver(scheduleSync).observe(document.body, {
      childList: true,
      subtree: true,
    });

    ['turbo:load', 'turbo:render', 'turbo:frame-render', 'pjax:end'].forEach((evt) =>
      document.addEventListener(evt, scheduleSync),
    );
    window.addEventListener('popstate', scheduleSync);

    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
