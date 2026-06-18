/**
 * WhatsApp Auto Translator — Content Script v4 (Fixed)
 * ----------------------------------------------------------
 * - Updated selectors for current WhatsApp Web DOM (2025+)
 * - Reliable Google Translate free endpoint
 * - Proper incoming message detection
 * - No debug logs in production
 * - Security: input sanitization, CSP-safe
 * - Premium subscription gating via chrome.storage
 * - Animated loader UX
 */

(() => {
  'use strict';

  const CONFIG = {
    // FREE tier — unofficial Google Translate (no key)
    FREE_API_URL: 'https://translate.googleapis.com/translate_a/single',
    // PREMIUM tier — official Google Cloud Translation API v2
    PAID_API_URL: 'https://translation.googleapis.com/language/translate/v2',
    PAID_API_KEY: '',      // loaded from chrome.storage
    SOURCE_LANG: 'auto',
    TARGET_LANG: 'en',
    DEBOUNCE_MS: 600,
    MAX_RETRIES: 3,
    RETRY_DELAY: 1500,
    MARKER_ATTR: 'data-wat-translated',
    POLL_INTERVAL: 3000,
    FREE_LIMIT: 20,
  };

  // Updated selectors for WhatsApp Web 2025
  const SELECTORS = {
    chatPane: [
      // Most specific first
      '[data-testid="conversation-panel-messages"]',
      'div[role="application"]',
      '#main .copyable-area',
      '#main [role="list"]',
      '#main',
    ],
    // Incoming messages — WhatsApp marks them with data-id starting with "false_"
    // or the class message-in (older builds)
    messageRow: [
      'div[data-id^="false_"]',   // ✅ Current WhatsApp Web — incoming
      'div.message-in',
      '[data-testid="msg-container"]',
    ],
    messageText: [
      // Most precise selector for text content
      '[data-testid="balloon-text-content"] > span',
      'span.selectable-text[dir]',
      '[class*="copyable-text"] span[dir]',
      'span[dir="rtl"]',
      'span[dir="ltr"]',
      'span[dir="auto"]',
      'span.selectable-text span',
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
      if (changes.watEnabled !== undefined) isEnabled = changes.watEnabled.newValue;
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
    return typeof text === 'string' && text.trim().length >= 2 && text.length <= 5000;
  }

  /* ============================================
     TRANSLATION API — Dual Mode
     ============================================ */

  /**
   * FREE tier: unofficial Google Translate endpoint
   * Uses client=gtx which works without an API key
   */
  async function translateFree(text) {
    const url = new URL(CONFIG.FREE_API_URL);
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', CONFIG.SOURCE_LANG);
    url.searchParams.set('tl', CONFIG.TARGET_LANG);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    let translated = '';
    if (Array.isArray(data?.[0])) {
      translated = data[0]
        .filter(p => Array.isArray(p) && p[0])
        .map(p => p[0])
        .join('');
    }
    const detectedLang = data?.[2] ?? '';
    return { text: translated.trim(), detectedLang };
  }

  /**
   * PREMIUM tier: official Google Cloud Translation API v2
   */
  async function translatePremium(text) {
    const url = new URL(CONFIG.PAID_API_URL);
    url.searchParams.set('key', CONFIG.PAID_API_KEY);

    const body = {
      q: text,
      target: CONFIG.TARGET_LANG,
      format: 'text',
    };
    if (CONFIG.SOURCE_LANG !== 'auto') {
      body.source = CONFIG.SOURCE_LANG;
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const translated = data?.data?.translations?.[0]?.translatedText || '';
    const detectedLang = data?.data?.translations?.[0]?.detectedSourceLanguage || '';
    return { text: translated.trim(), detectedLang };
  }

  /**
   * Main translate function with exponential backoff retry
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
        await sleep(CONFIG.RETRY_DELAY * Math.pow(1.5, attempt));
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
    // Time stamps like "12:30 PM"
    if (/^\d{1,2}:\d{2}(\s?(AM|PM|am|pm))?$/.test(t)) return true;
    // Tick marks (message status icons)
    if (/^[✓✔✔✔]+$/.test(t)) return true;
    // Zero-width chars
    if (/^[\u200B-\u200D\uFEFF]+$/.test(t)) return true;
    // Pure emoji only (optional — comment out if you want emoji messages translated)
    // if (/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})+$/u.test(t)) return true;
    return false;
  }

  /**
   * Extracts the main visible text from a message element.
   * Tries each selector in order, returns the first valid non-noise text.
   */
  function extractMessageText(messageEl) {
    // Walk up to find the actual message container
    const root = messageEl.closest('[data-id]') || messageEl.closest('.message-in') || messageEl;

    for (const sel of SELECTORS.messageText) {
      try {
        const candidates = root.querySelectorAll(sel);
        for (const el of candidates) {
          const text = el.innerText?.trim() ?? el.textContent?.trim();
          if (!isNoiseText(text)) return text;
        }
      } catch (_) { /* skip bad selector */ }
    }

    // Last-resort fallback: pick the longest meaningful span
    let best = '';
    try {
      root.querySelectorAll('span').forEach((span) => {
        const t = (span.innerText ?? span.textContent)?.trim();
        if (!isNoiseText(t) && t.length > best.length) best = t;
      });
    } catch (_) {}
    return best;
  }

  /**
   * Returns true if this element represents an INCOMING message.
   * WhatsApp uses:
   *   - data-id="false_..." → incoming
   *   - data-id="true_..."  → outgoing
   *   - class "message-in"  → incoming (older builds)
   *   - class "message-out" → outgoing
   */
  function isIncomingMessage(el) {
    // Check data-id attribute (most reliable on current WhatsApp Web)
    const dataId = el.getAttribute('data-id') ||
                   el.closest('[data-id]')?.getAttribute('data-id') || '';
    if (dataId.startsWith('true_')) return false;   // outgoing
    if (dataId.startsWith('false_')) return true;   // incoming

    // Fallback: CSS class check
    if (el.closest('.message-out')) return false;
    if (el.closest('.message-in') || el.classList?.contains('message-in')) return true;

    // Walk up limited depth
    let parent = el;
    for (let i = 0; i < 10; i++) {
      if (!parent) break;
      if (parent.classList?.contains('message-out')) return false;
      if (parent.classList?.contains('message-in')) return true;
      parent = parent.parentElement;
    }

    return false;
  }

  /**
   * Finds the visual bubble element to append the translation badge to.
   */
  function findBubble(messageEl) {
    const root = messageEl.closest('[data-id]') || messageEl.closest('.message-in') || messageEl;
    return (
      root.querySelector('[data-testid="msg-container"]') ||
      root.querySelector('[class*="copyable-text"]')?.closest('div') ||
      root
    );
  }

  /* ============================================
     BADGE CREATION
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
    // DEDUP: marker attribute or existing badge
    if (messageEl.getAttribute(CONFIG.MARKER_ATTR)) return;
    if (messageEl.querySelector('.wat-translation')) return;

    const text = extractMessageText(messageEl);
    if (!isValidText(text)) return;

    // Mark immediately to prevent race conditions
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

    // DEDUP: bubble already has badge
    if (bubble.querySelector('.wat-translation')) {
      messageEl.setAttribute(CONFIG.MARKER_ATTR, 'done');
      return;
    }

    const badge = createLoadingBadge();
    bubble.appendChild(badge);

    try {
      const result = await translateText(text);

      if (!result.text) {
        badge.remove();
        messageEl.setAttribute(CONFIG.MARKER_ATTR, 'empty');
        return;
      }

      // Skip if detected language IS the target language (already in target lang)
      if (result.detectedLang && result.detectedLang === CONFIG.TARGET_LANG) {
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
      setError(badge, 'Translation unavailable. Check your connection.');
      messageEl.setAttribute(CONFIG.MARKER_ATTR, 'error');
    }
  }

  async function drainQueue() {
    if (isProcessing) return;
    isProcessing = true;
    while (pendingQueue.length > 0) {
      if (!isEnabled) { pendingQueue = []; break; }
      const el = pendingQueue.shift();
      try { await processMessage(el); } catch (_) {}
      await sleep(250);
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

        // Direct incoming message node
        if (isIncomingMessage(node)) {
          if (!node.getAttribute(CONFIG.MARKER_ATTR)) newMessages.add(node);
        }

        // Search children for incoming message containers
        try {
          // data-id="false_..." pattern (current WhatsApp Web)
          node.querySelectorAll?.('[data-id^="false_"]')?.forEach((el) => {
            if (!el.getAttribute(CONFIG.MARKER_ATTR)) newMessages.add(el);
          });
          // legacy class pattern
          node.querySelectorAll?.('.message-in')?.forEach((el) => {
            if (!el.getAttribute(CONFIG.MARKER_ATTR)) newMessages.add(el);
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

    // Current WhatsApp Web pattern
    try {
      root.querySelectorAll('[data-id^="false_"]').forEach((el) => {
        if (!el.getAttribute(CONFIG.MARKER_ATTR)) messages.add(el);
      });
    } catch (_) {}

    // Legacy class pattern
    try {
      root.querySelectorAll('.message-in').forEach((el) => {
        if (!el.getAttribute(CONFIG.MARKER_ATTR) && isIncomingMessage(el)) messages.add(el);
      });
    } catch (_) {}

    messages.forEach((el) => pendingQueue.push(el));
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
        if (retries > 30) {
          clearInterval(interval);
          startPolling(); // keep polling even if not found yet
        }
      }, 2000);
    } else {
      startPolling();
    }
  }

  if (document.readyState === 'complete') {
    setTimeout(init, 1200);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1800));
  }

})();
