const t = (key) => chrome.i18n.getMessage(key) || key;

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = t('popupTitle');
document.querySelectorAll('[data-i18n]').forEach((el) => {
  el.textContent = t(el.dataset.i18n);
});

chrome.storage.local.get('ghToken').then(({ ghToken }) => {
  document.getElementById('tokenState').textContent = t(
    ghToken ? 'popupTokenSet' : 'popupTokenUnset',
  );
});
