/**
 * WhatsApp Auto Translator — Popup Script v3 (Production)
 * --------------------------------------------------------
 * Settings, counter, Stripe subscription, and API key management.
 */

(() => {
  'use strict';

  /* ============================================
     DOM ELEMENTS
     ============================================ */
  const toggleEl      = document.getElementById('toggleEnabled');
  const statusDot     = document.getElementById('statusDot');
  const statusText    = document.getElementById('statusText');
  const sourceLang    = document.getElementById('sourceLang');
  const targetLang    = document.getElementById('targetLang');
  const transCount    = document.getElementById('transCount');
  const transLimit    = document.getElementById('transLimit');
  const progressFill  = document.getElementById('progressFill');
  const premiumCard   = document.getElementById('premiumCard');
  const premiumBadge  = document.getElementById('premiumBadge');
  const priceTag      = document.getElementById('priceTag');
  const btnSubscribe  = document.getElementById('btnSubscribe');
  const apiKeySection = document.getElementById('apiKeySection');
  const apiKeyInput   = document.getElementById('apiKeyInput');
  const btnSaveKey    = document.getElementById('btnSaveKey');

  /* ============================================
     CONSTANTS
     ============================================ */
  const FREE_LIMIT = 20; // Free tier limit — upgrade to Premium for unlimited

  // ⚠️ REPLACE with your actual Stripe Payment Link
  const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/YOUR_PAYMENT_LINK_HERE';

  /* ============================================
     UI HELPERS
     ============================================ */
  function updateStatusUI(enabled) {
    statusDot.classList.toggle('off', !enabled);
    statusText.textContent = enabled ? 'Active' : 'Paused';
  }

  function updateCounter(count, premium) {
    transCount.textContent = count;
    if (premium) {
      transLimit.textContent = '(unlimited)';
      progressFill.style.width = '100%';
      progressFill.classList.remove('warning');
    } else {
      transLimit.textContent = `/ ${FREE_LIMIT} free`;
      const pct = Math.min((count / FREE_LIMIT) * 100, 100);
      progressFill.style.width = `${pct}%`;
      progressFill.classList.toggle('warning', pct >= 80);
    }
  }

  function updatePremiumUI(premium, hasKey) {
    if (premium) {
      premiumCard.classList.add('active');
      premiumBadge.textContent = '✅ Premium Active';
      premiumBadge.classList.add('active-badge');
      priceTag.style.display = 'none';
      btnSubscribe.textContent = 'Subscribed ✓';
      btnSubscribe.classList.add('subscribed');
      btnSubscribe.disabled = true;
      apiKeySection.style.display = 'block';

      if (hasKey) {
        apiKeyInput.value = '••••••••••••••••';
        apiKeyInput.disabled = true;
        btnSaveKey.textContent = 'Saved ✓';
        btnSaveKey.classList.add('saved');
      }
    }
  }

  /* ============================================
     LOAD SAVED STATE
     ============================================ */
  chrome.storage.local.get(
    ['watEnabled', 'watSourceLang', 'watTargetLang', 'watPremium', 'watTransCount', 'watApiKey'],
    (result) => {
      const enabled = result.watEnabled !== undefined ? result.watEnabled : true;
      toggleEl.checked = enabled;
      updateStatusUI(enabled);

      if (result.watSourceLang) sourceLang.value = result.watSourceLang;
      if (result.watTargetLang) targetLang.value = result.watTargetLang;

      const premium = !!result.watPremium;
      const count = result.watTransCount || 0;
      const hasKey = !!result.watApiKey;

      updateCounter(count, premium);
      updatePremiumUI(premium, hasKey);
    }
  );

  /* ============================================
     EVENT LISTENERS — Settings
     ============================================ */
  toggleEl.addEventListener('change', () => {
    chrome.storage.local.set({ watEnabled: toggleEl.checked });
    updateStatusUI(toggleEl.checked);
  });

  sourceLang.addEventListener('change', () => {
    chrome.storage.local.set({ watSourceLang: sourceLang.value });
  });

  targetLang.addEventListener('change', () => {
    chrome.storage.local.set({ watTargetLang: targetLang.value });
  });

  /* ============================================
     STRIPE SUBSCRIPTION
     ============================================ */
  btnSubscribe.addEventListener('click', () => {
    if (btnSubscribe.disabled) return;
    chrome.tabs.create({ url: STRIPE_PAYMENT_LINK });
  });

  /* ============================================
     API KEY MANAGEMENT
     ============================================ */
  btnSaveKey.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();

    // Don't save masked placeholder
    if (!key || key === '••••••••••••••••') return;

    // Basic validation: Google Cloud API keys are typically 39 chars
    if (key.length < 20) {
      apiKeyInput.style.borderColor = '#ef4444';
      setTimeout(() => { apiKeyInput.style.borderColor = ''; }, 2000);
      return;
    }

    // Save securely to chrome.storage
    chrome.storage.local.set({ watApiKey: key }, () => {
      apiKeyInput.value = '••••••••••••••••';
      apiKeyInput.disabled = true;
      btnSaveKey.textContent = 'Saved ✓';
      btnSaveKey.classList.add('saved');

      // Reset after 3 seconds to allow re-editing
      setTimeout(() => {
        btnSaveKey.textContent = 'Update';
        btnSaveKey.classList.remove('saved');
        apiKeyInput.disabled = false;
        apiKeyInput.value = '';
        apiKeyInput.placeholder = 'Key saved • enter new key to update';
      }, 3000);
    });
  });

  /* ============================================
     STORAGE CHANGE LISTENER
     ============================================ */
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.watPremium) {
      const premium = !!changes.watPremium.newValue;
      chrome.storage.local.get(['watApiKey'], (r) => {
        updatePremiumUI(premium, !!r.watApiKey);
      });
    }
    if (changes.watTransCount) {
      chrome.storage.local.get(['watPremium'], (r) => {
        updateCounter(changes.watTransCount.newValue, !!r.watPremium);
      });
    }
  });

})();
