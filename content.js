/**
 * WhatsApp Auto Translator — Content Script v3 (Production)
 * ----------------------------------------------------------
 * - No debug logs in production
 * - Security: input sanitization, CSP-safe
 * - Premium subscription gating via chrome.storage
 * - Animated loader UX
 * - Google Translate (FREE, no API key)
 */

(() => {
  'use strict';

  const CONFIG = {
    // FREE tier — unofficial Google Translate (no key, limited)
    FREE_API_URL: 'https://translate.googleapis.com/translate_a/single',
    // PREMIUM tier — official Google Cloud Translation API v2 (reliable, unlimited)
    PAID_API_URL: 'https://translation.googleapis.com/language/translate/v2',
    PAID_API_KEY: '',      // loaded from chrome.storage
    SOURCE_LANG: 'auto',
    TARGET_LANG: 'en',
    DEBOUNCE_MS: 500,
    MAX_RETRIES: 2,
    RETRY_DELAY: 2000,
    MARKER_ATTR: 'data-wat-translated',
    POLL_INTERVAL: 3000,
    FREE_LIMIT: 20,  // Free tier limit — upgrade to Premium for unlimited
  };

  const SELECTORS = {
    chatPane: [
      '[data-testid="conversation-panel-messages"]',
      '#main div[role="application"]',
      '#main .copyable-area',
      '#main',
    ],
    messageRow: [
      'div.message-in',
      'div[class*="message-in"]',
      '[data-testid="msg-container"]',
      'div[role="row"].message-in',
    ],
    messageText: [
      '[data-testid="balloon-text-content"] span[dir]',
      'span[dir="ltr"]',
      'span[dir="rtl"]',
      'span[dir="auto"]',
      'span.selectable-text span',
      'span.selectable-text',
      '[class*="copyable-text"] span[dir]',
      '[class*="copyable-text"] span',
    ],
  };

  /* --- State --- */
  let isEnabled = true;
  let isPremium = false;
  let translationCount = 0;
  let observer = null;
  let pendingQueue = [];
  let isProcessing = false;
  let pollTimer = null;
  let lastChatPane = null;

  /* ============================================
     STORAGE
     ============================================ */
  try {
    chrome.storage?.local.get(
      ['watEnabled', 'watSourceLang', 'watTargetLang', 'watPremium', 'watTransCount', 'watApiKey'],
      (result) => {
        if (chrome.runtime.lastError) return;
        if (result.watEnabled !== undefined) isEnabled = result.watEnabled;
        if (result.watSourceLang) CONFIG.SOURCE_LANG = result.watSourceLang;
        if (result.watTargetLang) CONFIG.TARGET_LANG = result.watTargetLang;
        if (result.watPremium) isPremium = result.watPremium;
        if (result.watTransCount) translationCount = result.watTransCount;
        if (result.watApiKey) CONFIG.PAID_API_KEY = result.watApiKey;
      }
    );

    chrome.storage?.onChanged.addListener((changes) => {
      if (changes.watEnabled) isEnabled = changes.watEnabled.newValue;
      if (changes.watSourceLang) CONFIG.SOURCE_LANG = changes.watSourceLang.newValue;
      if (changes.watTargetLang) CONFIG.TARGET_LANG = changes.watTargetLang.newValue;
      if (changes.watPremium) isPremium = changes.watPremium.newValue;
      if (changes.watApiKey) CONFIG.PAID_API_KEY = changes.watApiKey.newValue;
    });
  } catch (_) {}

  /* ============================================
     SECURITY
     ============================================ */
  function sanitize(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function isValidText(text) {
    return typeof text === 'string' && text.length >= 2 && text.length <= 5000;
  }

  /* ============================================
     SELECTOR HELPERS
     ============================================ */
  function queryFirst(root, selectorList) {
    for (const sel of selectorList) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function queryAll(root, selectorList) {
    const results = new Set();
    for (const sel of selectorList) {
      try { root.querySelectorAll(sel).forEach((el) => results.add(el)); }
      catch (_) {}
    }
    return results;
  }

  /* ============================================
     TRANSLATION API — Dual Mode
     Free users  → unofficial Google Translate (free, limited)
     Premium     → official Google Cloud Translation API v2
     ============================================ */

  /**
   * FREE tier: unofficial Google Translate endpoint
   * Returns { text, detectedLang } so we can skip same-language messages
   */
  async function translateFree(text) {
    const params = new URLSearchParams({
      client: 'gtx',
      sl: CONFIG.SOURCE_LANG,
      tl: CONFIG.TARGET_LANG,
      dt: 't',
      q: text,
    });

    const response = await fetch(`${CONFIG.FREE_API_URL}?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    let translated = '';
    if (data?.[0]) {
      translated = data[0].map(p => p[0]).filter(Boolean).join('');
    }
    const detectedLang = data?.[2] || '';
    return { text: translated, detectedLang };
  }

  /**
   * PREMIUM tier: official Google Cloud Translation API v2
   */
  async function translatePremium(text) {
    const params = new URLSearchParams({ key: CONFIG.PAID_API_KEY });
    const response = await fetch(`${CONFIG.PAID_API_URL}?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: text,
        source: CONFIG.SOURCE_LANG === 'auto' ? undefined : CONFIG.SOURCE_LANG,
        target: CONFIG.TARGET_LANG,
        format: 'text',
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const translated = data?.data?.translations?.[0]?.translatedText || '';
    const detectedLang = data?.data?.translations?.[0]?.detectedSourceLanguage || '';
    return { text: translated, detectedLang };
  }

  /**
   * Main translate function — picks API based on subscription
   * Returns { text, detectedLang }
   */
  async function translateText(text, attempt = 0) {
    try {
      if (isPremium && CONFIG.PAID_API_KEY) {
        return await translatePremium(text);
      } else {
        return await translateFree(text);
      }
    } catch (err) {
      if (attempt < CONFIG.MAX_RETRIES) {
        await sleep(CONFIG.RETRY_DELAY);
        return translateText(text, attempt + 1);
      }
      throw err;
    }
  }

  /* ============================================
     DOM HELPERS
     ============================================ */
  function isNoiseText(text) {
    if (!text) return true;
    const t = text.trim();
    if (t.length < 2) return true;
    if (/^\d{1,2}:\d{2}(\s?(AM|PM|am|pm))?$/.test(t)) return true;
    if (/^[✓✔✔✔]+$/.test(t)) return true;
    if (/^[\u200B-\u200D\uFEFF]+$/.test(t)) return true;
    return false;
  }

  function extractMessageText(messageEl) {
    const root = messageEl.closest('.message-in') || messageEl;
    for (const sel of SELECTORS.messageText) {
      try {
        const textEl = root.querySelector(sel);
        if (textEl) {
          const text = textEl.innerText?.trim();
          if (!isNoiseText(text)) return text;
        }
      } catch (_) { /* skip */ }
    }

    // Fallback: longest meaningful span text in the bubble
    const bubble = findBubble(root);
    let best = '';
    bubble.querySelectorAll('span[dir], span').forEach((span) => {
      const t = span.innerText?.trim();
      if (!isNoiseText(t) && t.length > best.length) best = t;
    });
    return best;
  }

  function isIncomingMessage(el) {
    if (el.closest('.message-out')) return false;
    if (el.classList?.contains('message-in') || el.closest('.message-in')) return true;

    let parent = el;
    for (let i = 0; i < 8; i++) {
      if (!parent) break;
      if (parent.classList?.contains('message-out')) return false;
      if (parent.classList?.contains('message-in')) return true;
      parent = parent.parentElement;
    }

    const dataId = el.closest('[data-id]')?.getAttribute('data-id') || '';
    if (dataId.startsWith('false_')) return true;
    if (dataId.startsWith('true_')) return false;
    return false;
  }

  function findBubble(messageEl) {
    const root = messageEl.closest('.message-in') || messageEl;
    return root.querySelector('[data-testid="msg-container"]') ||
           root.querySelector('[class*="copyable-text"]')?.closest('div') ||
           root;
  }

  /* ============================================
     BADGE CREATION — Premium UI
     ============================================ */
  function createLoadingBadge() {
    const badge = document.createElement('div');
    badge.classList.add('wat-translation', 'wat-translation--loading');
    badge.innerHTML = `
      <div class="wat-translation-label">
        <span class="wat-spinner"></span>
        <span>Translating</span>
      </div>
      <div class="wat-translation-text">
        <span class="wat-dots"><span></span><span></span><span></span></span>
      </div>`;
    return badge;
  }

  function setTranslated(badge, text) {
    badge.classList.remove('wat-translation--loading');
    badge.innerHTML = `
      <div class="wat-translation-label">
        <span class="wat-icon">🌐</span>
        <span>Translated</span>
      </div>
      <div class="wat-translation-text">${sanitize(text)}</div>`;
  }

  function setError(badge, msg) {
    badge.classList.remove('wat-translation--loading');
    badge.classList.add('wat-translation--error');
    badge.innerHTML = `
      <div class="wat-translation-label">
        <span class="wat-icon">⚠️</span>
        <span>Error</span>
      </div>
      <div class="wat-translation-text">${sanitize(msg)}</div>`;
  }

  function setLocked(badge) {
    badge.classList.remove('wat-translation--loading');
    badge.classList.add('wat-translation--locked');
    badge.innerHTML = `
      <div class="wat-translation-label">
        <span class="wat-icon">🔒</span>
        <span>Premium Required</span>
      </div>
      <div class="wat-translation-text">Free limit reached. Upgrade to Premium for unlimited translations.</div>`;
  }

  /* ============================================
     MESSAGE PROCESSING
     ============================================ */
  async function processMessage(messageEl) {
    // DEDUP CHECK 1: marker attribute
    if (messageEl.getAttribute(CONFIG.MARKER_ATTR)) return;

    // DEDUP CHECK 2: already has a translation badge in DOM
    if (messageEl.querySelector('.wat-translation')) return;

    const text = extractMessageText(messageEl);
    if (!isValidText(text)) return;

    // Mark IMMEDIATELY to prevent any race condition duplicates
    messageEl.setAttribute(CONFIG.MARKER_ATTR, 'pending');

    // Check free limit
    if (!isPremium && translationCount >= CONFIG.FREE_LIMIT) {
      const bubble = findBubble(messageEl);
      const badge = createLoadingBadge();
      bubble.appendChild(badge);
      setLocked(badge);
      messageEl.setAttribute(CONFIG.MARKER_ATTR, 'locked');
      return;
    }

    const bubble = findBubble(messageEl);

    // DEDUP CHECK 3: bubble already has badge
    if (bubble.querySelector('.wat-translation')) {
      messageEl.setAttribute(CONFIG.MARKER_ATTR, 'done');
      return;
    }

    const badge = createLoadingBadge();
    bubble.appendChild(badge);

    try {
      const result = await translateText(text);

      // Skip if detected language IS the target language (already in English)
      if (result.detectedLang === CONFIG.TARGET_LANG) {
        badge.remove();
        messageEl.setAttribute(CONFIG.MARKER_ATTR, 'same-lang');
        return;
      }

      // Skip if translation is identical to original
      if (result.text.toLowerCase().trim() === text.toLowerCase().trim()) {
        badge.remove();
        messageEl.setAttribute(CONFIG.MARKER_ATTR, 'same');
        return;
      }

      setTranslated(badge, result.text);
      messageEl.setAttribute(CONFIG.MARKER_ATTR, 'done');

      translationCount++;
      try { chrome.storage?.local.set({ watTransCount: translationCount }); } catch (_) {}
    } catch (err) {
      setError(badge, 'Translation unavailable. Try again later.');
      messageEl.setAttribute(CONFIG.MARKER_ATTR, 'error');
    }
  }

  async function drainQueue() {
    if (isProcessing) return;
    isProcessing = true;
    while (pendingQueue.length > 0) {
      if (!isEnabled) { pendingQueue = []; break; }
      const el = pendingQueue.shift();
      await processMessage(el);
      await sleep(300);
    }
    isProcessing = false;
  }

  /* ============================================
     MUTATION OBSERVER
     ============================================ */
  let debounceTimer = null;

  function handleMutations(mutations) {
    if (!isEnabled) return;
    const newMessages = new Set();

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        if (node.matches?.('.message-in') && isIncomingMessage(node)) {
          if (!node.getAttribute(CONFIG.MARKER_ATTR)) newMessages.add(node);
        }

        try {
          queryAll(node, SELECTORS.messageRow).forEach((row) => {
            const msgEl = row.closest('.message-in') || row;
            if (!msgEl.getAttribute(CONFIG.MARKER_ATTR) && isIncomingMessage(msgEl)) newMessages.add(msgEl);
          });
        } catch (_) {}

        if (node.matches?.('[data-testid="msg-container"]')) {
          const parent = node.closest('.message-in');
          if (parent && !parent.getAttribute(CONFIG.MARKER_ATTR)) newMessages.add(parent);
        }

        try {
          node.querySelectorAll?.('.message-in')?.forEach((child) => {
            if (!child.getAttribute(CONFIG.MARKER_ATTR)) newMessages.add(child);
          });
        } catch (_) {}
      }
    }

    if (newMessages.size === 0) return;
    newMessages.forEach((el) => pendingQueue.push(el));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(drainQueue, CONFIG.DEBOUNCE_MS);
  }

  /* ============================================
     OBSERVER SETUP
     ============================================ */
  function findChatPane() {
    for (const sel of SELECTORS.chatPane) {
      try {
        const pane = document.querySelector(sel);
        if (pane) return pane;
      } catch (_) {}
    }
    return null;
  }

  function attachObserver() {
    const chatPane = findChatPane();
    if (!chatPane) return false;
    if (chatPane === lastChatPane && observer) return true;

    if (observer) observer.disconnect();

    observer = new MutationObserver(handleMutations);
    observer.observe(chatPane, { childList: true, subtree: true });
    lastChatPane = chatPane;

    scanExistingMessages(chatPane);
    return true;
  }

  function scanExistingMessages(root) {
    if (!isEnabled) return;
    const messages = new Set();
    queryAll(root, SELECTORS.messageRow).forEach((el) => {
      const msgEl = el.closest('.message-in') || el;
      if (isIncomingMessage(msgEl)) messages.add(msgEl);
    });
    root.querySelectorAll?.('.message-in')?.forEach((el) => messages.add(el));
    messages.forEach((el) => {
      if (!el.getAttribute(CONFIG.MARKER_ATTR)) pendingQueue.push(el);
    });
    if (pendingQueue.length > 0) drainQueue();
  }

  function startPolling() {
    pollTimer = setInterval(() => {
      const currentPane = findChatPane();
      if (currentPane && currentPane !== lastChatPane) attachObserver();
      if (!currentPane && lastChatPane) {
        if (observer) observer.disconnect();
        lastChatPane = null;
      }
    }, CONFIG.POLL_INTERVAL);
  }

  /* ============================================
     UTILITIES
     ============================================ */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ============================================
     INIT
     ============================================ */
  function init() {
    if (!attachObserver()) {
      let retries = 0;
      const interval = setInterval(() => {
        retries++;
        if (attachObserver()) {
          clearInterval(interval);
          startPolling();
        }
        if (retries > 20) {
          clearInterval(interval);
          startPolling();
        }
      }, 3000);
    } else {
      startPolling();
    } 
  }

  if (document.readyState === 'complete') {
    setTimeout(init, 1000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1500));
  }

})();
