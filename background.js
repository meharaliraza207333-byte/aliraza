/**
 * WhatsApp Auto Translator — Background Service Worker (MV3)
 * Handles storage sync and relays messages between popup and content script.
 */
chrome.runtime.onInstalled.addListener(() => {
  // Set default values on first install
  chrome.storage.local.get(['watEnabled', 'watSourceLang', 'watTargetLang'], (result) => {
    const defaults = {};
    if (result.watEnabled === undefined) defaults.watEnabled = true;
    if (!result.watSourceLang) defaults.watSourceLang = 'auto';
    if (!result.watTargetLang) defaults.watTargetLang = 'en';
    if (Object.keys(defaults).length > 0) {
      chrome.storage.local.set(defaults);
    }
  });
});
