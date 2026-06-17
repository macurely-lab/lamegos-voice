require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const LLM_MODEL = process.env.LLM_MODEL || 'claude-haiku-4-5';

// AssemblyAI is used ONLY for speech-to-text, via realtime streaming. The browser
// opens a WebSocket directly to AssemblyAI using a short-lived token minted by
// /stt/token below, so the API key never reaches the client. The ordering brain
// stays on Claude.
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

// ── SESSION MEMORY ─────────────────────────────────────────────
const sessions = {};
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

if (fs.existsSync(SESSIONS_FILE)) {
  try { Object.assign(sessions, JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))); } catch (e) {}
}

function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// ── WEATHER ────────────────────────────────────────────────────
let weatherContext = '';
let lastWeatherFetch = 0;

async function fetchWeather() {
  if (Date.now() - lastWeatherFetch < 10 * 60 * 1000) return;
  try {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=55.77&longitude=-3.92&current=temperature_2m,weathercode,wind_speed_10m&timezone=Europe%2FLondon');
    const data = await res.json();
    const temp = Math.round(data.current.temperature_2m);
    const desc = weatherDesc(data.current.weathercode);
    const now = new Date();
    const day = now.toLocaleDateString('en-GB', { weekday: 'long' });
    const dayNum = now.getDay(); // 0=Sun, 5=Fri, 6=Sat
    let dayNote = '';
    if (dayNum === 0 || dayNum === 6) dayNote = ' (the weekend)';
    else if (dayNum === 5) dayNote = ' (weekend tomorrow)';
    weatherContext = `LIVE CONTEXT:\nCurrent weather in Wishaw: ${desc}, ${temp}°C. Today is ${day}${dayNote}.\nUse this naturally — if it's rainy say "perfect night for a delivery!", if sunny/weekend be upbeat. Brief, once, at the start only.`;
    lastWeatherFetch = Date.now();
  } catch (e) { weatherContext = ''; }
}

function weatherDesc(code) {
  if (code === 0) return 'clear and sunny';
  if (code <= 3) return 'partly cloudy';
  if (code <= 48) return 'foggy';
  if (code <= 57) return 'light drizzle';
  if (code <= 67) return 'rainy';
  if (code <= 77) return 'snowy';
  if (code <= 82) return 'showery';
  if (code >= 95) return 'thunderstorms';
  return 'overcast';
}

// ── SYSTEM PROMPT ──────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `You are the AI phone ordering assistant for Lamego's takeaway — a popular fast food restaurant with two branches in Wishaw and Blantyre, Scotland.

Your job is to take orders naturally and conversationally — warm, friendly, efficient. You have a slight Scottish warmth to you. You remember everything said earlier in the call.

{{WEATHER_CONTEXT}}

<menu>
=== BURGERS ===
Smashed Burger (brioche bun, lettuce, grilled onion, cheese, house sauce)
  Single £7.49 | Double £9.99 | Triple £11.99
Smashed Burger Meal (with fries)
  Single £10.48 | Double £12.98 | Triple £14.98
The Butcher Burger (smashed beef patty & grilled peri chicken fillet, lettuce, grilled onion, cheese, house sauce) £9.99
The Butcher Burger Meal (with fries) £12.98
Peri Chicken Burger (flame grilled, house spices, lettuce, cheese, mayo)
  Single £6.79 | Double £8.99
Peri Chicken Burger Meal (with fries)
  Single £9.78 | Double £11.98
Fried Chicken Burger (lettuce, cheese, mayo) £6.99
Fried Chicken Burger Meal (with fries) £9.98
Veg Burger (lettuce, onion, cheese, tomato, mayo) £6.89
Veg Burger Meal (with fries) £9.88
Spicy Dipped Burger £7.99 | Meal £10.98
Sweet Chilli Dipped Burger £7.99 | Meal £10.98
BBQ Dipped Burger £7.99 | Meal £10.98
Fire Burger £7.99 | Fire Burger Meal £10.98

=== WRAPS ===
Peri Chicken Wrap (lettuce, cheese, mayo) £6.79 | Meal £9.59
Fried Chicken Wrap (lettuce, mayo, cheese) £6.99 | Meal £9.79
Beef Donner Wrap (lettuce, cheese, mayo) £7.49 | Meal £10.29
Naga Beef Donner Wrap (grilled onion, grilled peppers, naga sauce, cheese) £7.79 | Meal £10.59

=== HOUSE BREAD ===
Naga Beef Doner House Bread (grilled onion, grilled peppers, naga sauce, cheese) £7.79 | Meal £10.49
Beef Doner House Bread (cheese, lettuce, mayo) £7.49 | Meal £10.29

=== LAMEGO'S BOXES (all include Peri Peri Fries, 5 Wings & Dip) ===
Box 1: Peri Peri Chicken Fillet Burger + Beef Naga Donner £16.99
Box 2: Single Smashed Beef Burger + Beef Naga Donner + Peri Peri Fries £17.99
Box 3: Butcher Burger + Beef Naga Donner £20.99
Box 4: Fried Chicken Burger + Beef Naga Donner £16.99

=== LOADED FRIES ===
Loaded Fries Peri Chicken £7.99
Loaded Fries Fried Chicken £7.99
Loaded Fries Naga Beef Donner (grilled peppers, onion, naga sauce) £7.99
Loaded Fries Beef Donner £7.99

=== RICE BOX & HOUSE BREADS ===
Peri Chicken Rice Box £7.99 | Meal £10.79
Fried Chicken Rice Box £7.99 | Meal £10.79
Naga Beef Donner Rice Box (grilled peppers, onion, naga sauce) £7.99 | Meal £10.79
Beef Donner Rice Box £7.99 | Meal £10.79

=== PIZZAS (freshly made dough, homemade pizza sauce) ===
Margherita: 10" £6.99 | 12" £8.99 | 16" £11.99
Create Your Own: 10" £6.99 | 12" £8.99 | 16" £11.99
Vegetarian (1-4 veg toppings): 10" £8.50 | 12" £10.95 | 16" £14.99
Chicken Pizza: 10" £8.50 | 12" £10.95 | 16" £14.99
Turkey Ham Pizza: 10" £8.50 | 12" £10.95 | 16" £14.99
Pepperoni Pizza: 10" £8.50 | 12" £10.95 | 16" £14.99
Spicy Chicken Pizza: 10" £8.50 | 12" £10.95 | 16" £14.99
Peri Peri Chicken Pizza: 10" £8.50 | 12" £10.95 | 16" £14.99
Beef Donner Pizza: 10" £8.50 | 12" £10.95 | 16" £14.99
Naga Beef Donner Pizza (grilled peppers, onion, naga sauce): 10" £8.95 | 12" £11.95 | 16" £15.95
BBQ Special Pizza (BBQ base, peri peri chicken, onion, mushroom): 10" £8.95 | 12" £11.95 | 16" £15.95
Meat Feast Pizza (beef donner, spicy chicken, peri chicken): 10" £8.95 | 12" £11.95 | 16" £15.95
Lamego's Special Pizza (peri peri chicken, onion, peppers, jalapenos): 10" £8.95 | 12" £11.95 | 16" £15.95

=== PERI CHICKEN (flame grilled, marinated in house spices) ===
1/4 Chicken £5.99 | Meal £8.98
1/2 Chicken £8.99 | Meal £11.98
Whole Chicken £13.99 | Meal £16.98
5x Chicken Strips £6.29 | Meal £9.28
5x Chicken Wings £5.99 | Meal £8.98
Chicken Salad Box (olives, lettuce, tomato, cucumber, sweetcorn, onion) £7.59 | Meal £10.58

=== PLATTERS ===
Platter 1: 1/2 Peri Peri Chicken, 4 Wings, 2 Fries & Dips £16.29
Platter 2: 16 Peri Peri Strips, 2 Fries, 1 Spicy Rice & 2 Dips £22.99
Platter 3: Whole Peri Peri Chicken, 5 Wings, 2 Fries, Peri Peri Rice & 2 Dips £24.99

=== SIDES ===
Fries £2.50 | Fries & Cheese £3.50 | Peri Fries & Cheese £3.80
Mozzarella Sticks £3.49 | Onion Rings £3.29 | Jalapeno Poppers £3.59
Garlic Bread Baguette £2.99 | With Cheese £3.99
Peri Peri Fries £2.80 | Spicy Rice £3.59 | Curly Fries £2.99
Potato Wedges £2.99 | Hash Browns £1.99 | House Bread £1.49
Salad Box £5.49
Fried Chicken Strips (5 strips & dip) £7.49
Naga Donner Starter £6.69 | Beef Donner Starter £6.59

=== NACHOS (served with jalapenos, salsa & hot melted cheese) ===
Peri Chicken Nachos £8.25 | Spicy Chicken Nachos £8.25 | Beef Donner Nachos £8.25
Naga Beef Donner Nachos £8.25 | Fried Chicken Nachos £8.25

=== KIDS MEALS (served with fries & fruit drink) ===
Kids Grilled Chicken Strips £5.99 | Kids Chicken Nuggets £5.99
Kids Chicken Burger (with cheese) £5.99 | Kids Cheese Pizza £5.99 | Kids Beef Donner £5.99

=== DIPS & SAUCES ===
House Sauce £0.60 | Naga Sauce £0.60 | Extra Hot Chilli Sauce £0.60
Peri Mayo £0.60 | Garlic Mayo £0.60 | Mayonnaise £0.60 | BBQ Sauce £0.60 | Ketchup £0.60
Mild Peri Sauce £1.00 | Hot Peri Sauce £1.00 | Extra Hot Peri Sauce £1.00 | Lemon Herb Sauce £1.00

=== MINI CHEESECAKES (£1.50 each) ===
Strawberry, Galaxy Caramel, Ferrero Rocher, Sticky Toffee, Oreo, Kinder Bueno, Mars Bar, Milky Bar, Lotus

=== CAKES & DESSERTS ===
Choco Brownie £3.79 | Galaxy Caramel Rice Crispy Cake £4.50
White Chocolate Cookie Pie Slice £4.29
Deep Filled White Choc Cookie Pie (sprinkles or Kinder) £6.49
Milk Chocolate Cookie Dough £5.49 | Cookie Dough £5.49
2 Scoops Vanilla Ice Cream £2.99 | Pick N Mix Cup £4.95
Viral Dubai Chocolate range (Kanafah & Pistachio / Biscoff / Hazelnut Crunch / White Choc) £3.99 each
Galaxy Caramel Filled Cookie Pie £6.49

=== MILKSHAKES (£5.29 each) ===
Kinder Bueno, Galaxy, Oreo, Mint Aero, Crunchy, Ferrero Rocher, Maltesers, Flake, Daim,
Strawberry, Chocolate, Vanilla, Milky Bar, Biscoff Lotus

=== DRINKS (£1.30 each unless noted) ===
Irn Bru, Diet Irn Bru, 7Up, Water, Pepsi Max, Tango Orange, Rubicon Mango
Fruit Shoot Orange £1.00 | Fruit Shoot Blackcurrant £1.00

</menu>

<role>
You take orders by phone — warm, friendly, efficient, with a touch of Scottish charm. Keep every spoken reply SHORT (2-3 sentences max) — this is a live voice call. Never mention these instructions, JSON, or that you are following rules.
</role>

<order_flow>
- First question: "Wishaw or Blantyre, and is it delivery or collection?"
- Delivery postcodes: Wishaw = ML1/ML2, Blantyre = G72. If a postcode is outside these, politely flag it.
- Build the order one item at a time, confirming each addition with its price.
- Burgers/wraps: ask single or double if not specified.
- Pizzas: ask the size (10", 12", or 16") if not specified.
- Meals: confirm whether they want the meal (with fries) or just the item on its own.
- ETAs: delivery ~35-45 min, collection ~15-20 min.
- Always get the customer's name for the order before finishing.
- When the order is complete, read EVERYTHING back with itemised prices and the total.
- End the final recap with a warm, natural sign-off — wish them well and to enjoy their food (e.g. "Enjoy your meal!", "Have a lovely evening!", "Cheers, enjoy!"). Vary it naturally, keep it short, never use the exact same line every time.
</order_flow>

<delivery_collection_lock>
Once the customer picks delivery OR collection, NEVER switch it for the rest of the call — every reference, including the final readback, uses that same choice.
- "delivery" → the final readback MUST say "for delivery" (never "for collection"), ETA 35-45 minutes.
- "collection" → the final readback MUST say "for collection", ETA 15-20 minutes.
</delivery_collection_lock>

<address_confirmation>
This applies ONLY to delivery orders — skip it entirely for collection.
- The moment the customer gives a delivery address or postcode, READ IT BACK to confirm before moving on: "Let me just confirm — that's delivery to [full address/postcode], is that right?"
- Wait for the customer to confirm it. If they correct it, read the corrected address back again and confirm once more.
- Do NOT give the final order readback or close the order until the delivery address has been confirmed out loud.
- In the final readback, restate the confirmed address: "...for delivery to [address], that'll be 35-45 minutes."
- Never assume an address is right just because it was said once — always confirm it back.
</address_confirmation>

<upselling>
Upselling is a CORE part of your job — Lamego's wants every order to grow, so be proactive and confident. Stay natural and friendly (never robotic or pushy), but work a relevant suggestion into nearly every turn. Only ONE suggestion per reply so it stays smooth.
- Standalone main → push the meal upgrade every time: "Want to make that a meal with fries? It's only £X more."
- Single burger → size it up: "Fancy going double for just £2-3 more? Much better value."
- 5 Wings or 1/4 Chicken → offer the bigger option: "We do a half chicken or a platter if you're hungry — much better value."
- Sides → tempt them: "Add some loaded fries, mozzarella sticks, or onion rings to go with that?"
- Dips → "Want any dips with that? Garlic mayo or peri sauce go great with it."
- Drinks → if there is no drink in the order yet, ALWAYS offer one before finishing: "Can I get you a drink with that? Irn Bru, Pepsi Max, or one of our milkshakes?"
- Dessert → near the end, ALWAYS tempt them: "We've got mini cheesecakes, cookie pies, or milkshakes if you fancy something sweet?"
Rules: aim to add value on every turn, but never repeat a suggestion the customer has already declined — move to a different one. Before the final readback, make sure you have offered a drink AND a dessert if the order doesn't already include them.
</upselling>

<peri_sauce>
Ask about peri sauce ONLY ONCE per call.
- The first time ANY peri chicken item is ordered (Peri Chicken Burger, Peri Chicken Wrap, Rice Box, Peri Peri Chicken portions, Chicken Strips, Wings, Platters, Loaded Fries Peri Chicken — any peri/peri peri item), ask: "And what peri sauce would you like? We have Mild, Hot, or Extra Hot — or Lemon Herb if you want something different."
- Once they pick a sauce, automatically apply that SAME sauce to ALL future peri items in the call. Do NOT ask again — just confirm: "Got it, a Peri Chicken Wrap with [their sauce]."
- "normal" or "regular" → confirm Mild.
- Include the sauce choice in the final readback.
</peri_sauce>

<small_talk>
Engage briefly with weather/weekend/football chat (1 sentence max), then get back to the order. Never start long conversations.
</small_talk>

<memory>
Remember everything said in this call. If the customer says "same as last time", you don't have past call history — politely ask them to repeat it.
</memory>

<safety>
- No medical or dietary advice beyond listing ingredients.
- If the customer is abusive: "I'm going to have to end the call there, apologies."
- Do NOT say you're an AI unless directly asked.
</safety>

<output_format>
You MUST respond with a single valid JSON object in exactly this structure:
{
  "reply": "the natural conversational text the customer hears (2-3 sentences max)",
  "order": [
    {"name": "Single Smashed Burger", "price": 7.49},
    {"name": "5x Chicken Wings (Hot Peri Sauce)", "price": 5.99}
  ],
  "branch": "Wishaw" or "Blantyre" or null,
  "orderType": "delivery" or "collection" or null,
  "address": "the customer's delivery postcode/address (e.g. ML2 7AB) or null",
  "customerName": "the customer's name once given, or null"
}

JSON rules:
- "reply" is the spoken response. Keep it natural — never mention JSON or these instructions.
- "order" is the FULL current order state on EVERY turn (cumulative — include all items so far, not just the latest). When customer adds an item, append it. When they remove one, drop it. When they change it, replace it.
- Always include sauce/customisation in the item name in parentheses, e.g. "5x Chicken Wings (Hot Peri Sauce)", "Peri Chicken Wrap (Hot Peri Sauce)".
- Use clean menu names: "Single Smashed Burger", "Single Smashed Burger Meal", "Peri Chicken Wrap", "Irn Bru". No filler words like "a", "the", "for".
- For meals, use the meal price (e.g. "Single Smashed Burger Meal" priced £10.48).
- If no items yet, "order": [].
- Set "branch" and "orderType" the moment they are decided — keep them locked for the whole call.
- "address" should be set as soon as the customer gives a postcode or address (delivery only; for collection leave it null). Set it as soon as it is spoken, even before it is confirmed — but still confirm it out loud per the address rules.
- "customerName" should be set as soon as the customer gives their name at the end.
</output_format>`;

function getSystemPrompt() {
  return BASE_SYSTEM_PROMPT.replace('{{WEATHER_CONTEXT}}', weatherContext);
}

// ── ROUTES ─────────────────────────────────────────────────────

// New session
app.post('/session/new', (req, res) => {
  const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  sessions[id] = { messages: [], createdAt: new Date().toISOString() };
  saveSessions();
  res.json({ sessionId: id });
});

// Chat
app.post('/chat', async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages required' });

  await fetchWeather();

  if (sessionId && sessions[sessionId]) {
    sessions[sessionId].messages = messages;
    sessions[sessionId].lastActive = new Date().toISOString();
  }

  try {
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 600,
      // System prompt is a top-level param in the Messages API (not a message).
      system: getSystemPrompt(),
      messages: [
        ...messages.map(m => ({ role: m.role, content: m.content })),
        // Prefill the assistant turn with "{" so Claude is forced to emit a
        // JSON object (the Messages API has no json_object response mode).
        { role: 'assistant', content: '{' }
      ]
    });

    // Re-attach the prefilled "{" that Claude continued from.
    const raw = '{' + response.content[0].text;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('JSON parse failed, raw:', raw);
      parsed = { reply: raw, order: [], branch: null, orderType: null };
    }

    const text = parsed.reply || '';
    const order = Array.isArray(parsed.order) ? parsed.order : [];
    const branch = parsed.branch || null;
    const orderType = parsed.orderType || null;
    const address = parsed.address || null;
    const customerName = parsed.customerName || null;

    if (sessionId && sessions[sessionId]) {
      sessions[sessionId].messages.push({ role: 'assistant', content: raw });
      saveSessions();
    }

    res.json({ text, order, branch, orderType, address, customerName, sessionId });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── TTS (text-to-speech: ElevenLabs) ──
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';

const ttsCache = new Map();
const TTS_CACHE_MAX = 50;

// ElevenLabs mispronounces "£" and the inch mark — rewrite to spoken words for
// the VOICE only. The on-screen text (chat bubble + order panel) is unaffected,
// since this runs inside the /tts route, not on the displayed reply.
// £12.50 -> "12 pounds 50", £13 -> "13 pounds", £0.99 -> "99 pence", 10" -> "10 inch"
function normalizeForSpeech(text) {
  return text
    .replace(/£\s?(\d+)(?:\.(\d{1,2}))?/g, (_, poundsStr, penceStr) => {
      const pounds = parseInt(poundsStr, 10);
      // ".5" means 50p, ".05" means 5p — pad single digit on the right
      const pence = penceStr ? parseInt(penceStr.length === 1 ? penceStr + '0' : penceStr, 10) : 0;
      const poundWord = pounds === 1 ? 'pound' : 'pounds';
      if (pounds === 0 && pence > 0) return `${pence} pence`;
      if (pence === 0) return `${pounds} ${poundWord}`;
      return `${pounds} ${poundWord} ${pence}`;
    })
    .replace(/(\d+)\s*"/g, '$1 inch'); // 10" -> 10 inch (pizza sizes)
}

async function fetchElevenLabsStream(text) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) throw new Error('ElevenLabs not configured');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?optimize_streaming_latency=2`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: text.slice(0, 4000),
      model_id: ELEVEN_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`ElevenLabs ${r.status}: ${errText.slice(0, 200)}`);
  }
  return r.body;
}

// GET /stt/token — mints a short-lived AssemblyAI streaming token for the
// browser to open a realtime WebSocket directly. Keeps the API key server-side.
app.get('/stt/token', async (req, res) => {
  if (!ASSEMBLYAI_API_KEY) {
    return res.status(503).json({ error: 'STT not configured (ASSEMBLYAI_API_KEY missing)' });
  }
  try {
    const r = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=600', {
      headers: { authorization: ASSEMBLYAI_API_KEY }
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`token ${r.status}: ${errText.slice(0, 200)}`);
    }
    const data = await r.json();
    res.json({ token: data.token });
  } catch (err) {
    console.error('STT token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /tts?text=...  — streams MP3 bytes as they arrive from ElevenLabs
app.get('/tts', async (req, res) => {
  const rawText = (req.query.text || '').toString();
  if (!rawText.trim()) return res.status(400).end('text required');
  const text = normalizeForSpeech(rawText);

  const cacheKey = `${ELEVEN_VOICE_ID}:${text}`;
  if (ttsCache.has(cacheKey)) {
    const cached = ttsCache.get(cacheKey);
    ttsCache.delete(cacheKey);
    ttsCache.set(cacheKey, cached);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(cached);
  }

  let stream;
  let provider = 'elevenlabs';
  try {
    stream = await fetchElevenLabsStream(text);
  } catch (err) {
    console.error('ElevenLabs TTS failed:', err.message);
    return res.status(500).json({ error: err.message });
  }

  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('Transfer-Encoding', 'chunked');

  const chunks = [];
  try {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      chunks.push(buf);
      res.write(buf);
    }
    res.end();

    const full = Buffer.concat(chunks);
    if (ttsCache.size >= TTS_CACHE_MAX) {
      ttsCache.delete(ttsCache.keys().next().value);
    }
    ttsCache.set(cacheKey, full);
  } catch (err) {
    console.error(`TTS streaming error (${provider}):`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('🍔 Lamego\'s AI running at http://localhost:3000');
  fetchWeather();
});