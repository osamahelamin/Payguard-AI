// server.js - PayGuard AI: AI agent + PayPal Sandbox integration
import express from "express";
import dotenv from "dotenv";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAmount, fallbackAgent } from "./src/utils.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_API = "https://api-m.sandbox.paypal.com",
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-5-5",
  PORT = 3000,
} = process.env;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ---------- PayPal helpers ---------- */

let cachedToken = { value: null, expiresAt: 0 };

// OAuth2 token with caching (FIX: correct Content-Type + error handling + reuse)
async function generateAccessToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    body: "grant_type=client_credentials",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`PayPal auth failed: ${data.error_description || response.status}`);
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function paypal(pathname, body) {
  const token = await generateAccessToken();
  const response = await fetch(`${PAYPAL_API}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "PayPal-Request-Id": crypto.randomUUID(), // idempotency
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `PayPal error ${response.status}`);
  return data;
}

async function createEmergencyOrder({ amount, description = "Emergency checkout", store = "Carrefour" }) {
  const order = await paypal("/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [
      {
        description: `${description} @ ${store}`.slice(0, 127),
        amount: { currency_code: "USD", value: normalizeAmount(amount) },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "PayGuard AI",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: `${BASE_URL}/success`,
          cancel_url: `${BASE_URL}/cancel`,
        },
      },
    },
  });
  const payUrl = order.links?.find((l) => ["payer-action", "approve"].includes(l.rel))?.href;
  return { id: order.id, status: order.status, payUrl };
}

/* ---------- AI agent ---------- */

const SYSTEM_PROMPT = `You are PayGuard AI, an emergency checkout recovery agent.
A shopper's bank card/terminal failed at a physical store. Be fast, calm, and brief.
Reply ONLY with JSON (no markdown):
{"reply":"<English, max 2 sentences>","reply_ar":"<Arabic translation>",
"failure_type":"bank_outage|card_declined|terminal_down|unknown",
"action":"create_checkout|ask_amount|none",
"amount":"<number or null>","description":"<short item summary>","store":"<store name or Carrefour>"}
Use create_checkout only when the user confirms a failure AND gave a total amount; otherwise ask_amount.`;

async function runAgent(message, history = []) {
  if (!ANTHROPIC_API_KEY) return fallbackAgent(message);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [...history.slice(-6), { role: "user", content: message }],
      }),
    });
    const data = await response.json();
    const text = data.content?.find((b) => b.type === "text")?.text ?? "";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.warn("LLM unavailable, using fallback agent:", err.message);
    return fallbackAgent(message);
  }
}

/* ---------- Routes ---------- */

// Chat with the agent; it auto-triggers PayPal checkout when appropriate
app.post("/api/agent", async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || typeof message !== "string") return res.status(400).json({ error: "message required" });
    const decision = await runAgent(message, history);
    let checkout = null;
    if (decision.action === "create_checkout" && decision.amount) {
      checkout = await createEmergencyOrder({
        amount: decision.amount, description: decision.description, store: decision.store,
      });
    }
    res.json({ ...decision, checkout });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Direct endpoint (original) - create emergency order
app.post("/api/emergency-checkout", async (req, res) => {
  try {
    res.json(await createEmergencyOrder({ amount: req.body.amount || "50.00", description: req.body.description }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PayPal redirects here after the shopper approves; we capture and show the receipt
app.get("/success", async (req, res) => {
  try {
    const orderId = req.query.token;
    if (!orderId) throw new Error("Missing order token");
    const capture = await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`);
    const unit = capture.purchase_units?.[0]?.payments?.captures?.[0];
    res.send(receiptPage(true, {
      code: unit?.id ?? capture.id, amount: unit?.amount?.value, currency: unit?.amount?.currency_code, status: capture.status,
    }));
  } catch (error) {
    res.status(500).send(receiptPage(false, { error: error.message }));
  }
});

app.get("/cancel", (_req, res) => res.send(receiptPage(false, { error: "Payment cancelled" })));
app.get("/health", (_req, res) => res.json({ ok: true, llm: Boolean(ANTHROPIC_API_KEY) }));

function receiptPage(ok, d) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;background:#0b1220;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#111b30;padding:32px;border-radius:20px;max-width:380px;text-align:center;border:1px solid ${ok ? "#22c55e" : "#ef4444"}">
<div style="font-size:56px">${ok ? "✅" : "⚠️"}</div>
<h2>${ok ? "Payment cleared · تم الدفع" : "Not completed · لم يكتمل"}</h2>
${ok ? `<p>Show this code to the cashier<br>أظهر هذا الرمز للكاشير</p>
<div style="font:700 22px monospace;background:#0b1220;padding:14px;border-radius:12px">${d.code}</div>
<p>${d.amount} ${d.currency} · ${d.status}</p>` : `<p>${d.error}</p>`}
<a href="/" style="color:#60a5fa">← PayGuard AI</a></div></body>`;
}

app.listen(PORT, () => console.log(`PayGuard AI running on ${BASE_URL} (LLM: ${ANTHROPIC_API_KEY ? "on" : "fallback"})`));
