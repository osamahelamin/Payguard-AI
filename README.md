# PayGuard AI: Autonomous Emergency Commerce & Offline Payment Recovery Agent

> An AI-powered emergency shopping agent that instantly resolves point-of-sale failures at major retail checkouts using PayPal Sandbox APIs.

![CI](https://github.com/YOUR_USERNAME/payguard-ai/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-MIT-blue)

## Flow
1. Shopper describes the failure (bank outage / card declined / terminal down).
2. AI agent diagnoses it and extracts the cart total.
3. Backend creates a PayPal Sandbox order (`/v2/checkout/orders`) and returns a Pay-by-Link.
4. Shopper approves on PayPal; `/success` captures the payment and shows a clearance code for the cashier.

## Run
```bash
npm install
cp .env.example .env   # add your PayPal Sandbox credentials
npm start              # http://localhost:3000
```
Without `ANTHROPIC_API_KEY` the agent uses a rule-based fallback, so the PayPal flow still demos end to end.

## Endpoints
- `POST /api/agent` – chat with the agent (auto-creates checkout)
- `POST /api/emergency-checkout` – direct order creation `{ "amount": "48.50" }`
- `GET /success` – captures approved order, returns receipt
- `GET /health`

## Bugs fixed from the original snippet
- Missing `Content-Type: application/x-www-form-urlencoded` on the OAuth token call
- No `response.ok` checks (PayPal errors were returned as 200s)
- Amount not validated/formatted (PayPal needs a 2-decimal string)
- Order was created but never captured; added approval redirect + `/success` capture
- Hardcoded port ignored `PORT`; removed `node-fetch` (Node 18+ has `fetch`); added token caching and idempotency key

## Project structure
```
payguard-ai/
├── server.js            # Express + PayPal + agent routes
├── src/utils.js         # Pure helpers (tested)
├── public/index.html    # Bilingual chat UI
├── test/                # node:test unit tests
├── docs/                # ARCHITECTURE.md (diagram), DEVPOST.md
├── Dockerfile
└── .github/workflows/ci.yml
```

## Docker
```bash
docker build -t payguard-ai .
docker run --env-file .env -p 3000:3000 payguard-ai
```

## Test
```bash
npm test
```

## License
MIT
