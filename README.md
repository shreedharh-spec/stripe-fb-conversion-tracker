# Stripe → Meta (Facebook) Conversions API Webhook (Render-ready)

This small Node.js server listens for Stripe Checkout success webhooks and forwards a **Purchase** event to **Meta Conversions API**. Perfect when your Stripe Checkout is hosted on a Stripe domain where the browser Pixel cannot run.

## Routes
- `GET /` → health check (`OK`)
- `POST /stripe/webhook` → Stripe sends events here. The server verifies the signature, extracts value/currency/email, and sends to Meta CAPI.

## Environment variables
Set these in **Render → your service → Environment**:

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...   # from Stripe after creating webhook
FB_PIXEL_ID=123456789012345
FB_ACCESS_TOKEN=EAAB...
# optional during testing:
FB_TEST_EVENT_CODE=TEST123
```

## Stripe events handled
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

## How it deduplicates (optional)
- The server uses **Checkout Session ID** as `event_id`. If you also fire a **browser Pixel Purchase** on your thank-you page using the same `event_id`, Meta will deduplicate. If you can’t, server-only is fine.

## Local dev
```
npm i
# create .env from .env.example and fill values
npm start
```

## Deploy to Render
- Build command: `npm i`
- Start command: `node server.js`

Create a Stripe webhook pointing to:
```
https://<your-render-app>.onrender.com/stripe/webhook
```
Then paste the **Signing secret** (whsec_...) into `STRIPE_WEBHOOK_SECRET` and redeploy.

## License
MIT
