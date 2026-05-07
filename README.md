# 🌐 WhatsApp Auto Translator — Chrome Extension

A premium Chrome Extension that automatically translates incoming WhatsApp Web messages in real-time. Supports **Roman Urdu**, Urdu script, Hindi, and 130+ languages.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## ✨ Features

- 🔄 **Real-time translation** via MutationObserver
- 🌍 **130+ languages** supported (Urdu, Hindi, Arabic, Chinese, etc.)
- 🇵🇰 **Roman Urdu support** — auto-detects "kya haal hai" → "How are you"
- 🎨 **Premium UI** — clean badges that blend with WhatsApp's design
- 🌗 **Light & Dark theme** support
- ⏳ **Animated loader** while translating
- 🔒 **Secure** — input sanitization, no debug logs in production
- 💎 **Freemium model** — free tier (20 translations) + Stripe premium subscription
- 🔑 **Dual API** — Free Google Translate for free users, Official Google Cloud API for premium

---

## 📁 Project Structure

```
whatsapp-translator/
├── manifest.json       # Chrome Extension config (Manifest V3)
├── content.js          # Core translation logic + MutationObserver
├── popup.html          # Extension popup UI (dark theme)
├── popup.js            # Popup controls (toggle, language, API key)
├── style.css           # Translation badge styles (light + dark)
├── .gitignore
├── README.md
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/whatsapp-translator.git
   ```
2. Open Chrome → navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **"Load unpacked"**
5. Select the `whatsapp-translator` folder
6. Open [web.whatsapp.com](https://web.whatsapp.com) — translations start automatically!

---

## ⚙️ Configuration

### Free Tier
- Uses unofficial Google Translate API (no key needed)
- Limited to 20 translations per session
- Supports auto language detection

### Premium Tier
- Uses official Google Cloud Translation API v2
- Unlimited translations
- Enter your API key in the extension popup
- Get your key from [Google Cloud Console](https://console.cloud.google.com/apis/credentials)

### Stripe Integration
Update the payment link in `popup.js`:
```js
const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/YOUR_LINK';
```

---

## 🛡️ Security

- All translated text is sanitized to prevent XSS
- No debug logs in production build
- API keys stored securely in `chrome.storage.local`
- Input validation (2–5000 characters)

---

## 📸 Screenshots

| Translation Badge | Popup UI |
|---|---|
| Clean badges below messages | Dark premium popup with controls |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License.

---

## ⚠️ Disclaimer

This extension is for personal use only. WhatsApp Web's DOM structure may change with updates, which could require selector updates. Use responsibly and within WhatsApp's Terms of Service.
