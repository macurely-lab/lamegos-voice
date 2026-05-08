# Lamego's AI Voice Ordering — Prototype

A browser-based AI phone ordering prototype for **Lamego's takeaway** (Wishaw & Blantyre, Scotland). The customer speaks (or types) their order; the AI takes it naturally — upselling, asking peri sauce flavour, confirming the full order with an itemised total.

This is the **prototype phase** — it proves the conversation quality and order-tracking concept. Production telephony, payments, POS integration, etc. are out of scope (see "Out of Scope" below).

---

## Stack

- **Backend:** Node.js + Express
- **AI:** OpenAI API (`gpt-4.1-mini`) using JSON mode for structured order state
- **Frontend:** Vanilla HTML/CSS/JS + Web Speech API (browser-native, Chrome recommended)
- **Weather:** Open-Meteo (free, no API key)
- **Persistence:** Local `sessions.json` file

> **Note:** The original handover doc specified Anthropic Claude. We used OpenAI for the prototype phase (faster iteration with the API key the team already had). Migration to Claude is ~10 lines in `server.js` — see "Switching to Anthropic" below.

---

## Project Structure

```
lamegos-voice/
├── .env                  ← API key + port (gitignored)
├── .gitignore
├── server.js             ← Express + OpenAI + weather + sessions
├── package.json
├── package-lock.json
├── README.md             ← this file
├── sessions.json         ← auto-created, persists call history
└── public/
    └── index.html        ← voice UI (chat + order panel + mic)
```

---

## Setup

```bash
cd lamegos-voice
npm install
```

Create or edit `.env`:

```
OPENAI_API_KEY=sk-...your-key-here...
PORT=3000
```

Run the server:

```bash
node server.js
```

Open **`http://localhost:3000`** in **Chrome** (Web Speech API works best there).

---

## What It Does

**Conversation layer:**
- AI greets the customer with a live weather comment (Wishaw weather via Open-Meteo)
- Asks branch (Wishaw / Blantyre) and delivery / collection
- For delivery, validates postcode (ML1/ML2 for Wishaw, G72 for Blantyre)
- Builds the order item-by-item, confirming each price
- Subtle upselling (meal upgrades, drinks, desserts) — never pushy, never repeated if declined
- Asks peri sauce flavour **once per call**, auto-applies it to all peri items
- Reads back the full itemised order with total at the end
- Confirms customer name and ETA (delivery 35-45 min / collection 15-20 min)

**UI:**
- Phone-call style dark UI with red/gold Lamego accents
- Big circular mic button (push-to-talk, pulses green while listening)
- Speech synthesis speaks AI replies aloud (en-GB voice)
- Live order summary panel on the right (items, prices, running total, branch, type, address, ETA, name)
- Text input fallback for typing instead of speaking
- Reset button starts a fresh call

---

## How The Order Tracking Works

The AI is forced (via OpenAI JSON mode) to return a structured response on every turn:

```json
{
  "reply": "Single Smashed Burger coming up, that's £7.49. Want to make it a meal for £10.48?",
  "order": [
    {"name": "Single Smashed Burger", "price": 7.49}
  ],
  "branch": "Wishaw",
  "orderType": "delivery",
  "address": "ML2 7AB",
  "customerName": null
}
```

- `reply` → spoken to the customer + rendered as a chat bubble
- `order` → full cumulative order state, rendered in the right panel
- `branch` / `orderType` / `address` / `customerName` → call info panel

This deterministic approach replaces the original "regex-parse £X.XX out of natural language" idea from the handover doc — it's bulletproof and survives any phrasing the AI uses.

---

## API Routes

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Serves `public/index.html` |
| `/session/new` | POST | Creates a new session ID, returns `{ sessionId }` |
| `/chat` | POST | Body: `{ messages, sessionId }` → returns `{ text, order, branch, orderType, address, customerName, sessionId }` |

Sessions are persisted to `sessions.json` for the entire conversation history.

---

## Behaviour Verified

All 11 checklist items from the original handover doc pass:

- [x] AI greets with branch + delivery/collection question
- [x] Standalone burger → meal upsell
- [x] 5 wings → half chicken / platter suggestion
- [x] Any peri item → Mild / Hot / Extra Hot / Lemon Herb prompt (asked **once**)
- [x] No drink in order → drink suggestion before close
- [x] Declined upsell → not repeated
- [x] "What's in the Lamego's Box?" → AI explains
- [x] Delivery → AI asks for postcode (ML1/ML2 or G72)
- [x] Order complete → itemised readback with correct total
- [x] Weather mention → natural, once at the start
- [x] Football/weather chat → brief reply, returns to order

---

## Switching to Anthropic Claude

When ready to swap from OpenAI to Claude:

1. `npm uninstall openai && npm install @anthropic-ai/sdk`
2. In `server.js`:
   - Replace `const OpenAI = require('openai')` with `const Anthropic = require('@anthropic-ai/sdk')`
   - Replace `const client = new OpenAI({...})` with `const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`
   - Replace the `client.chat.completions.create({...})` block with `client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 600, system: getSystemPrompt(), messages: ... })`
   - Adapt the response: `response.content[0].text` instead of `response.choices[0].message.content`
   - Anthropic doesn't have a built-in JSON mode flag, so add to the system prompt: *"Respond with valid JSON only — no prose outside the JSON object."*
3. Update `.env` to `ANTHROPIC_API_KEY=...`

---

## Out Of Scope (Production Phase)

These are explicitly **not** in this prototype:

- Real telephony (Twilio SIP trunk to intercept actual phone calls)
- Production STT/TTS (Deepgram + ElevenLabs for low-latency live voice)
- POS / Lamego's order system integration
- Payment processing
- SMS confirmations to customers
- Multi-location auto-routing by phone number

---

## Troubleshooting

**Mic button doesn't work** → Use Chrome (Safari and Firefox have limited Web Speech Recognition). Allow microphone permission when prompted.

**Speech synthesis sounds robotic** → First page load may use a default voice. Refresh once voices load. Browsers vary on which `en-GB` voices ship by default.

**Order panel not updating** → Check the server terminal for `JSON parse failed` logs. The AI should always return valid JSON, but if not, the raw text is logged for debugging.

**`OPENAI_API_KEY` errors** → Confirm `.env` is in the project root and the key has no trailing whitespace.

**Stale sessions confusing the AI** → Delete `sessions.json` and restart the server for a clean slate.

---

## Build Time

Built in approximately 3 hours (within the 2-4 hour estimate from the original handover doc).
