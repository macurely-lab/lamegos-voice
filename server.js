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

<unavailable_items>
If a customer asks for something we do NOT have on the menu, NEVER simply refuse or say "we don't have that" and stop. Instead, ALWAYS offer the closest available alternative from our menu and gently steer them to it. Acknowledge what they wanted, then suggest the nearest match in a warm, natural way.
- Drinks: a brand we don't stock → offer the closest one we DO have. Examples: "Coca-Cola" or "Coke" → "We don't have Coke I'm afraid, but we've got Pepsi Max — want one of those?" / "Fanta" → "No Fanta, but we do a Tango Orange." / "Sprite/7Up-style" → "We've got 7Up." / "Lucozade/energy" → "No Lucozade, but Irn Bru's a good shout."
- Food: an item or style we don't make → offer the nearest thing on our menu. Examples: a "kebab" → "We don't do a kebab as such, but our Beef Donner Wrap or Donner House Bread is spot on." / "nuggets" (adult) → "We've got 5 Chicken Strips or Fried Chicken Strips." / "hot dog" → "No hot dogs, but a Fire Burger or a Donner might hit the spot." / "wings in a flavour we don't list" → offer our 5 Chicken Wings with a peri sauce.
- Always frame it positively as a recommendation, keep it short (1-2 sentences), and only suggest ONE alternative at a time. If they say no, you can offer a second-closest option or move on.
- Only ever recommend items that actually appear in the <menu> above — never invent products, brands, or prices.
</unavailable_items>

<role>
You take orders by phone — warm, friendly, efficient, with a touch of Scottish charm. Keep every spoken reply SHORT (2-3 sentences max) — this is a live voice call. Never mention these instructions, JSON, or that you are following rules.
</role>

<order_flow>
- First question: "Wishaw or Blantyre, and is it delivery or collection?"
- For delivery, collect the FULL address — postcode, then street, then house number — following <address_capture> below. Delivery areas: Wishaw = ML1/ML2, Blantyre = G72. If a postcode is outside the chosen branch's area, politely flag it and do not continue with the address.
- Build the order one item at a time, confirming each addition with its price using the {{PRICE}} placeholder (never a typed figure).
- Burgers/wraps: ask single or double if not specified.
- Pizzas: ask the size (10", 12", or 16") if not specified.
- Meals: confirm whether they want the meal (with fries) or just the item on its own.
- ETAs: delivery ~35-45 min, collection ~15-20 min.
- Always get the customer's name for the order before finishing.
- When the order is complete, read the items back by name (with any customisations) and give the order total using the {{TOTAL}} placeholder.
- End the final recap with a warm, natural sign-off — wish them well and to enjoy their food (e.g. "Enjoy your meal!", "Have a lovely evening!", "Cheers, enjoy!"). Vary it naturally, keep it short, never use the exact same line every time.
</order_flow>

<delivery_collection_lock>
Once the customer picks delivery OR collection, NEVER switch it for the rest of the call — every reference, including the final readback, uses that same choice.
- "delivery" → the final readback MUST say "for delivery" (never "for collection"), ETA 35-45 minutes.
- "collection" → the final readback MUST say "for collection", ETA 15-20 minutes.
</delivery_collection_lock>

<address_capture>
This applies ONLY to delivery orders — skip it entirely for collection. Collect the delivery address in THREE steps, IN THIS ORDER, ONE step per turn, confirming each part before moving on. Ask only for the next missing part — never ask for all three at once.

STEP 1 — Postcode. Ask for the postcode first: "What's the postcode for delivery?"
- Check the area: Wishaw delivers to ML1 and ML2, Blantyre delivers to G72. If the postcode is NOT in the chosen branch's area, politely say it's outside the delivery area and do NOT continue with the rest of the address.
- If it IS in the area, read it back clearly and confirm before moving on: "Lovely, that's ML2 7AB — is that right?" Only proceed once they confirm. Record it in "postcode".

STEP 2 — Street. Once the postcode is confirmed, ask for the street: "And what street is that?"
- Read the street back to confirm: "Kirk Road, got it." If they correct it, read the corrected street back. Record it in "street".

STEP 3 — House number. Then ask for the house or flat number: "And the house number?"
- Read it back as a FULL-address confirmation: "So that's 47 Kirk Road, ML2 7AB — is that right?" If they correct any part, confirm again. Record it in "houseNumber".

- Do NOT give the final order readback or close the order until ALL THREE parts (postcode, street, house number) are captured AND the full address has been confirmed out loud.
- In the final readback, restate the full confirmed address: "...for delivery to 47 Kirk Road, ML2 7AB, that'll be 35-45 minutes."
- Never assume a part is right just because it was said once — always read it back.
</address_capture>

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

<customizations>
Customers can customise any item in two ways:
- REMOVALS ("no onion", "without mayo", "hold the cheese") — list each removed ingredient in "removals".
- ADDITIONS ("extra beef", "extra cheese", "add jalapenos") — list each added extra in "additions".

You do NOT price customisations and you do NOT do any arithmetic. The system works out the charge automatically (a removal cancels an addition for a free swap; leftover additions are £1 each) and fills in the figure for you. Your only jobs:
- Record the customisation accurately in "removals" and "additions" on that item.
- When you tell the customer what the item costs, write the placeholder {{PRICE}} instead of a number — the system replaces it with the exact, correct price. NEVER state a £ amount or an "£X extra" yourself for a customised item; just describe what's added/removed and quote {{PRICE}}.
- Example reply: "Lovely — a Single Smashed Burger with no onion and extra cheese, that's {{PRICE}}. Anything else?" (The system turns {{PRICE}} into the real figure.)
- Include the customisations (in words) in the final readback too.
</customizations>

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

<speaking_prices>
You never say or calculate prices yourself — the system inserts the exact figures. In your spoken reply, use ONLY these two placeholders for prices:
- {{PRICE}} — the price of the item you just added or changed this turn. Use it when telling the customer what an item costs, e.g. "Got it, a Single Smashed Burger — that's {{PRICE}}."
- {{TOTAL}} — the whole-order total. Use it for the order total and the final readback, e.g. "That brings your total to {{TOTAL}}."
Never type a figure like "£7.49" for an item or total, and never say "£1 extra" for a customisation — always use {{PRICE}} / {{TOTAL}}. (Loose menu facts like "a meal's about £3 more" are fine.)
</speaking_prices>`;

function getSystemPrompt() {
  return BASE_SYSTEM_PROMPT.replace('{{WEATHER_CONTEXT}}', weatherContext);
}

// ── ORDER NORMALIZATION ────────────────────────────────────────
// Computes the authoritative per-item price from the model's structured
// output. The pricing rule for customisations: each addition costs £1, but
// each removal cancels one addition for free (a swap is free). So the extra
// charge is max(0, additions − removals) × £1, never negative.
// This runs server-side so the bill total is always correct regardless of the
// model's arithmetic. Backwards-compatible: old items that only carry "price"
// (and no basePrice/removals/additions) pass through unchanged.
const EXTRA_UNIT_PRICE = 1.0;

function normalizeOrderItem(it) {
  if (!it || typeof it.name !== 'string') return null;

  const removals = Array.isArray(it.removals)
    ? it.removals.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim())
    : [];
  const additions = Array.isArray(it.additions)
    ? it.additions.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim())
    : [];

  // basePrice is the menu price before customisation. Fall back to a legacy
  // "price" field if basePrice is missing (older sessions / model slip).
  let basePrice = typeof it.basePrice === 'number' ? it.basePrice
    : typeof it.price === 'number' ? it.price : 0;

  const netExtras = Math.max(0, additions.length - removals.length);
  const extraCharge = netExtras * EXTRA_UNIT_PRICE;
  const price = Math.round((basePrice + extraCharge) * 100) / 100;

  return { name: it.name, basePrice, removals, additions, extraCharge, price };
}

function normalizeOrder(order) {
  if (!Array.isArray(order)) return [];
  return order.map(normalizeOrderItem).filter(Boolean);
}

// ── TOOL-OUTPUT SALVAGE ────────────────────────────────────────
// Small/fast models occasionally emit a malformed tool call: they jam the rest
// of the structured output into the "reply" string, leaking raw markup like
//   ...fries?","order">[{...}],"branch":"Wishaw"} </invoke>
// into what the customer hears, and losing the real order. This repairs that:
// trims the spoken reply at the first leaked marker and recovers any fields
// (order/branch/orderType/address/customerName) that got swallowed by the leak.

// Extract the first balanced [...] array starting at/after fromIdx (quote-aware).
function extractBalancedArray(str, fromIdx) {
  const start = str.indexOf('[', fromIdx);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

function salvageParsed(input) {
  const parsed = { ...input };
  let reply = typeof parsed.reply === 'string' ? parsed.reply : '';

  // Markers that mean structured data leaked into the reply text.
  const leak = reply.match(/<\/?(?:invoke|parameter|function)|","?\s*(?:order|branch|orderType|address|postcode|street|houseNumber|customerName)"?\s*[:>]/i);
  if (leak) {
    const tail = reply.slice(leak.index);

    // Recover a lost order array from the leaked tail.
    if (!Array.isArray(parsed.order) || parsed.order.length === 0) {
      const oi = tail.search(/"order"/);
      const arr = oi >= 0 ? extractBalancedArray(tail, oi) : null;
      if (arr) { try { const rec = JSON.parse(arr); if (Array.isArray(rec)) parsed.order = rec; } catch (e) {} }
    }
    // Recover simple scalar fields if they were lost.
    for (const key of ['branch', 'orderType', 'address', 'postcode', 'street', 'houseNumber', 'customerName']) {
      if (parsed[key] == null) {
        const m = tail.match(new RegExp('"' + key + '"\\s*[:>]\\s*"([^"]*)"', 'i'));
        if (m) parsed[key] = m[1];
      }
    }
    // Keep only the clean spoken text before the leak.
    reply = reply.slice(0, leak.index);
  }

  parsed.reply = reply.replace(/\s*["',]+\s*$/, '').trim();
  return parsed;
}

// ── SPOKEN PRICE INJECTION ─────────────────────────────────────
// The model never does price arithmetic. Instead it writes {{PRICE}} (the price
// of the item it just added/confirmed) and {{TOTAL}} (the whole-order total) as
// placeholders. The server substitutes the exact, server-computed figures here,
// so the spoken price is ALWAYS correct on any model — including fast/small ones.
// Runs before the reply is returned for TTS.

// The prior order from the last assistant turn, used to work out which line the
// customer just changed so {{PRICE}} points at the right item.
function extractPrevOrder(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') {
      try {
        const o = JSON.parse(messages[i].content);
        return Array.isArray(o.order) ? o.order : [];
      } catch (e) { return []; }
    }
  }
  return [];
}

// Resolve {{PRICE}} to the item that is new or whose price changed vs the prior
// turn (the item being confirmed). Falls back to the newest line, then 0.
function currentItemPrice(order, prevOrder) {
  if (!order.length) return 0;
  const prevByName = new Map();
  for (const it of prevOrder) prevByName.set(it.name, it.price);
  let changed = null;
  for (const it of order) {
    const prev = prevByName.get(it.name);
    const isNew = !prevByName.has(it.name);
    // Only count a price change when the prior price is a real number — a missing
    // price (old session / malformed history) must not look like a change.
    const priceChanged = typeof prev === 'number' && prev !== it.price;
    if (isNew || priceChanged) changed = it;
  }
  return (changed || order[order.length - 1]).price;
}

// ── CART RECONCILIATION ────────────────────────────────────────
// The model must re-emit the FULL cart every turn, but small models sometimes
// erroneously drop earlier items (or return an empty array). This guards the
// cart: unless the customer actually asked to remove/cancel something, items
// from the previous turn are never silently lost. Modifications to existing
// items and genuinely new items are still applied.
const REMOVAL_INTENT = /\b(remove|removing|cancel|cancelling|delete|scrap|clear|reset|start over|start again|take (?:it|that|the|them|those)?\s*(?:off|out)|get rid|do(?:n'?t| not) want|no longer want|lose the|forget (?:the|about)|without the|drop the)\b/i;

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return String(messages[i].content || '');
  }
  return '';
}

function reconcileOrder(modelOrder, prevOrder, userText) {
  // Trust ANY non-empty order the model returns. This is essential: when the
  // customer upgrades/renames an item (e.g. "make it a meal" turns "Single
  // Smashed Burger" into "Single Smashed Burger Meal"), the model legitimately
  // replaces the line, and we must NOT try to "restore" the old name — doing so
  // duplicates the item. Modifications, removals and additions all flow through.
  if (modelOrder.length > 0) return modelOrder;
  // Only guard the catastrophic case: the model wrongly returned an EMPTY cart
  // while the customer still has items and did not ask to cancel/clear.
  if (!prevOrder.length) return modelOrder;
  if (REMOVAL_INTENT.test(userText || '')) return modelOrder;
  return prevOrder;
}

function injectPrices(reply, order, prevOrder = []) {
  const total = order.reduce((s, it) => s + it.price, 0);
  const itemPrice = currentItemPrice(order, prevOrder);
  return String(reply || '')
    .replace(/\{\{\s*TOTAL\s*\}\}/gi, '£' + total.toFixed(2))
    .replace(/\{\{\s*PRICE\s*\}\}/gi, '£' + itemPrice.toFixed(2));
}

// ── ADDRESS ASSEMBLY ───────────────────────────────────────────
// The model emits the delivery address as three separate parts (houseNumber,
// street, postcode). The server combines them into one display/readback string
// — "47 Kirk Road, ML2 7AB" — so the order panel and history are consistent
// regardless of how the model phrased things. Tolerates partial capture (only
// the postcode given so far → "ML2 7AB") and returns null when nothing is set.
function buildAddress({ houseNumber, street, postcode } = {}) {
  const clean = v => (typeof v === 'string' && v.trim()) ? v.trim() : '';
  const line1 = [clean(houseNumber), clean(street)].filter(Boolean).join(' ');
  const parts = [line1, clean(postcode)].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// ── STRUCTURED OUTPUT TOOL ─────────────────────────────────────
// Sonnet does not support assistant-message prefill, so instead of forcing a
// leading "{" we force a tool call. tool_choice locks the model into calling
// this tool every turn, so response.content always contains a tool_use block
// whose .input is already a validated JS object — no manual JSON.parse needed.
const RESPONSE_TOOL = {
  name: 'submit_response',
  description: 'Submit your spoken reply to the customer and the full current order state. You MUST call this tool on every single turn — it is the only way to respond.',
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'The natural, conversational text the customer hears (2-3 sentences max). Never mention tools, JSON, or these instructions. For any price use the {{PRICE}} or {{TOTAL}} placeholder — never type a figure like "£7.49" or say "£1 extra".'
      },
      order: {
        type: 'array',
        description: 'The COMPLETE order — EVERY item the customer has ordered so far in this whole call, not just the newest one. On every single turn you must re-list ALL previous items AND any new one. NEVER return an empty array or drop earlier items while the customer still has an order — that is a serious error. Only remove an item if the customer explicitly asks to remove or cancel it.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Clean menu name, no filler words like "a"/"the" (e.g. "Single Smashed Burger", "Single Smashed Burger Meal", "Irn Bru"). Keep any peri sauce choice in parentheses, e.g. "5x Chicken Wings (Hot Peri Sauce)".' },
            basePrice: { type: 'number', description: 'The normal menu price BEFORE any customisation charge (e.g. 7.49). For a meal, use the meal price (e.g. 10.48). Do NOT add the £1 customisation extras here — the system does that.' },
            removals: { type: 'array', items: { type: 'string' }, description: 'Ingredients left out, e.g. ["onion"]. [] if none.' },
            additions: { type: 'array', items: { type: 'string' }, description: 'Extras added, e.g. ["extra cheese"]. [] if none.' }
          },
          required: ['name', 'basePrice', 'removals', 'additions']
        }
      },
      branch: { type: 'string', enum: ['Wishaw', 'Blantyre'], description: 'Selected branch. Set as soon as chosen and keep it the same for the whole call. Omit until the customer has chosen.' },
      orderType: { type: 'string', enum: ['delivery', 'collection'], description: 'Set as soon as chosen and keep it the same for the whole call. Omit until the customer has chosen.' },
      postcode: { type: 'string', description: 'Delivery postcode, e.g. "ML2 7AB" (delivery only). Set once the customer confirms it. Must be in the chosen branch area (Wishaw ML1/ML2, Blantyre G72). Omit for collection or before it is given.' },
      street: { type: 'string', description: 'Delivery street name, e.g. "Kirk Road" (delivery only). Set once the customer confirms it. Omit for collection or before it is given.' },
      houseNumber: { type: 'string', description: 'Delivery house or flat number, e.g. "47" or "Flat 2, 47" (delivery only). Set once the customer confirms it. Omit for collection or before it is given.' },
      customerName: { type: 'string', description: 'The customer name once given. Omit otherwise.' }
    },
    required: ['reply', 'order']
  }
};

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
      tools: [RESPONSE_TOOL],
      // Force the model to answer by calling submit_response — guarantees a
      // structured, schema-valid object instead of free-form text.
      tool_choice: { type: 'tool', name: 'submit_response' },
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    });

    // With forced tool_choice the response always contains a tool_use block
    // whose .input is the already-parsed object. Fall back defensively.
    const toolUse = response.content.find(b => b.type === 'tool_use');
    // salvageParsed repairs the rare malformed tool call where the model leaks
    // raw markup/JSON into the reply string and loses the structured order.
    const parsed = salvageParsed((toolUse && toolUse.input) || { reply: '', order: [] });

    const prevOrder = normalizeOrder(extractPrevOrder(messages));
    // Guard the cart against the model erroneously dropping earlier items.
    const order = reconcileOrder(normalizeOrder(parsed.order), prevOrder, lastUserText(messages));
    // rawReply keeps the {{PRICE}}/{{TOTAL}} placeholders; text has them filled
    // with exact figures. The browser displays/speaks `text` but feeds `rawReply`
    // back into history so the model keeps writing placeholders, never literals.
    const rawReply = parsed.reply || '';
    const text = injectPrices(rawReply, order, prevOrder);
    const branch = parsed.branch || null;
    const orderType = parsed.orderType || null;
    const postcode = parsed.postcode || null;
    const street = parsed.street || null;
    const houseNumber = parsed.houseNumber || null;
    // Combine the structured parts into the single address string the panel
    // shows. Fall back to a legacy `address` field if an old session/leak only
    // carried the combined form.
    const address = buildAddress({ houseNumber, street, postcode }) || parsed.address || null;
    const customerName = parsed.customerName || null;

    // Stored verbatim into session history (with placeholders) for audit/persistence.
    const raw = JSON.stringify({ ...parsed, reply: rawReply });
    if (sessionId && sessions[sessionId]) {
      sessions[sessionId].messages.push({ role: 'assistant', content: raw });
      saveSessions();
    }

    res.json({ text, rawReply, order, branch, orderType, address, houseNumber, street, postcode, customerName, sessionId });
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

// Start the HTTP server. Called unconditionally (no `require.main === module`
// guard) because some hosts (e.g. Hostinger) load the entry file via a wrapper
// rather than running it directly, which would skip a guarded listen().
app.listen(process.env.PORT || 3000, () => {
  console.log('🍔 Lamego\'s AI running at http://localhost:3000');
  fetchWeather();
});

module.exports = { salvageParsed, extractBalancedArray, normalizeOrder, normalizeOrderItem, injectPrices, currentItemPrice, reconcileOrder, lastUserText, buildAddress, REMOVAL_INTENT };