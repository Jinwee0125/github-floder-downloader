// GitHub Folder Downloader — service worker.
//
// Intentionally minimal: the heavy lifting (GitHub API calls, ZIP assembly and
// the actual download) runs in the content script because it needs the page
// DOM — `URL.createObjectURL` is unavailable in MV3 service workers, and the
// GitHub API / raw endpoints are CORS-enabled for the github.com origin.

// Allow content scripts (untrusted contexts) to use chrome.storage.session so
// the selection survives in-page (Turbo) navigation.
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (_) {
  /* chrome.storage.session unavailable (older Chrome) — selection stays in-memory */
}

chrome.runtime.onInstalled.addListener(async () => {
  const { ghToken } = await chrome.storage.local.get('ghToken');
  if (ghToken === undefined) {
    await chrome.storage.local.set({ ghToken: '' });
  }
});
