/**
 * Stripe → Meta (Facebook) Conversions API Bridge
 * Tracks: Purchase, InitiateCheckout, AbandonCheckout (custom)
 *
 * Env Vars (Render → Environment):
 *   STRIPE_SECRET_KEY       = sk_live_...
 *   STRIPE_WEBHOOK_SECRET   = whsec_...
 *   FB_PIXEL_ID             = 797127909306358
 *   FB_ACCESS_TOKEN         = EAAB...
 *   FB_TEST_EVENT_CODE      = TEST123  (optional; for Events Manager "Test Events")
 *   EVENT_SOURCE_URL        = https://yourdomain.com  (optional; used for attribution)
 *
 * Routes:
 *   GET  /                    → Health check ("OK")
 *   POST /stripe/webhook      → Stripe events → Meta CAPI
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Stripe = require('stripe');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
const EVENT_SOURCE_URL = process.env.EVENT_SOURCE_URL || 'https://pay.stripe.com';

// ===== Raw body ONLY for Stripe webhook route =====
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

// JSON parsing for any other routes
app.use(express.json());

// Health check
app.get('/', (req, res) => res.status(200).send('OK'));

// ---------- Helpers ----------
const sha256Lower = (s) =>
  s ? crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex') : null;

const nowInSeconds = () => Math.floor(Date.now() / 1000);

async function sendEventToMeta({
  pixelId,
  accessToken,
  eventName,      // "Purchase" | "InitiateCheckout" | "AbandonCheckout" (custom)
  eventId,        // for dedupe; use Stripe object id
  email,
  value,
  currency,
  sourceUrl,
  ip,
  ua,
  testEventCode,
  orderId,
}) {
  const user_data = {};
  if (email) user_data.em = [sha256Lower(email)];
  if (ip) user_data.client_ip_address = ip;
  if (ua) user_data.client_user_agent = ua;

  const custom_data = {};
  if (currency) custom_data.currency = String(currency).toUpperCase();
  if (typeof value === 'number') custom_data.value = value;
  if (orderId) custom_data.order_id = String(orderId);

  const body = {
    data: [
      {
        event_name: eventName,
        event_time: nowInSeconds(),
        action_source: 'website',
        event_id: eventId || undefined,
        event_source_url: sourceUrl || undefined,
        user_data,
        custom_data,
        test_event_code: testEventCode || undefined,
      },
    ],
  };

  const url = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;
  const resp = await axios.post(url, body, {
    timeout: 10000,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });
  return { status: resp.status, data: resp.data };
}

// ---------- Webhook Handler ----------
async function handleStripeWebhook(req, res) {
  const stripeSecret   = process.env.STRIPE_SECRET_KEY;
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
  const pixelId        = process.env.FB_PIXEL_ID;
  const accessToken    = process.env.FB_ACCESS_TOKEN;
  const testEventCode  = process.env.FB_TEST_EVENT_CODE;

  if (!stripeSecret || !webhookSecret || !pixelId || !accessToken) {
    console.error('❌ Missing env vars. Need STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, FB_PIXEL_ID, FB_ACCESS_TOKEN');
    return res.status(500).send('Server misconfigured');
  }

  const stripe = Stripe(stripeSecret);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('❌ Stripe signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Events we handle
  const handled = new Set([
    // Success / revenue
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'payment_intent.succeeded',
    'invoice.payment_succeeded',

    // Abandonment / failures
    'checkout.session.expired',
    'checkout.session.async_payment_failed',

    // Funnel start
    'checkout.session.created',
  ]);

  if (!handled.has(event.type)) {
    // Ignore quietly
    return res.json({ received: true });
  }

  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || undefined;

    let email = null;
    let amountMinor = null; // Stripe sends minor units (e.g., cents)
    let currency = 'USD';
    let orderId = null;
    let eventId = null;
    let eventName = null;

    const obj = event.data.object;

    switch (event.type) {
      // ======= FUNNEL START =======
      case 'checkout.session.created': {
        // Session created (user initiated checkout)
        // Minimal data at this point
        eventName = 'InitiateCheckout';
        eventId = obj.id;
        currency = (obj.currency || currency).toUpperCase();
        amountMinor = obj.amount_total ?? null;
        email = obj.customer_details?.email || obj.customer_email || null;
        orderId = obj.id;
        break;
      }

      // ======= SUCCESS =======
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        // Retrieve full session (ensures email, amounts, currency)
        const session = await stripe.checkout.sessions.retrieve(obj.id, {
          expand: ['customer', 'payment_intent'],
        });
        eventName = 'Purchase';
        eventId = session.id;
        currency = (session.currency || currency).toUpperCase();
        amountMinor = session.amount_total ?? null;
        email = session.customer_details?.email || session.customer_email || null;
        orderId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || session.id;
        break;
      }

      case 'payment_intent.succeeded': {
        // Direct API charges (not via Checkout)
        const pi = await stripe.paymentIntents.retrieve(obj.id, { expand: ['charges.data.billing_details'] });
        eventName = 'Purchase';
        eventId = pi.id;
        currency = (pi.currency || currency).toUpperCase();
        amountMinor = pi.amount ?? null;
        email = pi.charges?.data?.[0]?.billing_details?.email || null;
        orderId = pi.id;
        break;
      }

      case 'invoice.payment_succeeded': {
        // Subscriptions revenue
        eventName = 'Purchase';
        eventId = obj.id;
        currency = (obj.currency || currency).toUpperCase();
        amountMinor = obj.amount_paid ?? null;
        email = obj.customer_email || null;
        orderId = obj.id;
        break;
      }

      // ======= ABANDONMENT =======
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        eventName = 'AbandonCheckout'; // custom event name (create a Custom Conversion in Ads Manager)
        eventId = obj.id;
        currency = (obj.currency || currency).toUpperCase();
        amountMinor = obj.amount_total ?? null;
        email = obj.customer_details?.email || obj.customer_email || null;
        orderId = obj.id;
        break;
      }
    }

    // Convert to major units for Meta
    const value = typeof amountMinor === 'number' ? Number(amountMinor) / 100 : undefined;

    const result = await sendEventToMeta({
      pixelId,
      accessToken,
      eventName,
      eventId,
      email,
      value,
      currency,
      sourceUrl: EVENT_SOURCE_URL,
      ip,
      ua,
      testEventCode,
      orderId,
    });

    if (result.status >= 200 && result.status < 300) {
      console.log(`✅ Sent ${eventName} to Meta CAPI:`, JSON.stringify(result.data));
    } else {
      console.error(`⚠️ Meta CAPI non-2xx for ${eventName}:`, result.status, result.data);
    }
  } catch (err) {
    console.error('❌ Error handling Stripe event:', err);
    // Always acknowledge to prevent Stripe retry storms
  }

  res.json({ received: true });
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
