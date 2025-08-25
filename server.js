/**
 * Stripe → Meta (Facebook) Conversions API Bridge (Advanced Tracking, Improved)
 *
 * Events tracked:
 * - InitiateCheckout
 * - Purchase
 * - AbandonCheckout (custom)
 * - Lead
 * - Subscribe (custom)
 * - RenewSubscription (custom)
 * - CancelSubscription (custom)
 * - Refund (custom)
 * - PaymentFailed (custom)
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Stripe = require('stripe');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
const EVENT_SOURCE_URL = process.env.EVENT_SOURCE_URL || 'https://stripe.teampumpkin.in';

// ===== Stripe requires raw body for webhook =====
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

// JSON for other routes
app.use(express.json());

// Health check
app.get('/', (req, res) => res.status(200).send('OK'));

// ---------- Helpers ----------
const sha256Lower = (s) =>
  s ? crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex') : null;

const nowInSeconds = () => Math.floor(Date.now() / 1000);

// Stripe zero-decimal currency list
// https://stripe.com/docs/currencies/zero-decimal
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF',
  'KRW', 'MGA', 'PYG', 'RWF', 'UGX',
  'VND', 'VUV', 'XAF', 'XOF', 'XPF'
]);

function convertAmount(amountMinor, currency) {
  if (typeof amountMinor !== 'number') return undefined;
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) {
    return amountMinor; // already in major units
  }
  return amountMinor / 100;
}

async function sendEventToMetaWithRetry(payload, retries = 3) {
  const { pixelId, accessToken, body, eventName } = payload;

  const url = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await axios.post(url, body, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      });

      if (resp.status >= 200 && resp.status < 300) {
        console.log(`✅ Sent ${eventName} to Meta CAPI:`, JSON.stringify(resp.data));
        return resp.data;
      } else {
        console.error(`⚠️ Meta CAPI ${resp.status} for ${eventName}:`, resp.data);
        if (attempt < retries) {
          console.log(`🔄 Retrying Meta CAPI (attempt ${attempt + 1}/${retries})...`);
        }
      }
    } catch (err) {
      console.error(`❌ Error sending ${eventName} to Meta CAPI:`, err.message);
      if (attempt < retries) {
        console.log(`🔄 Retrying Meta CAPI (attempt ${attempt + 1}/${retries})...`);
      }
    }
  }

  console.error(`❌ Failed to send ${eventName} after ${retries} attempts`);
  return null;
}

async function sendEventToMeta({
  pixelId,
  accessToken,
  eventName,
  eventId,
  email,
  value,
  currency,
  sourceUrl,
  ip,
  ua,
  testEventCode,
  orderId,
  contentIds,
  numItems,
}) {
  const user_data = {};
  if (email) user_data.em = [sha256Lower(email)];
  if (ip) user_data.client_ip_address = ip;
  if (ua) user_data.client_user_agent = ua;

  const custom_data = {};
  if (currency) custom_data.currency = String(currency).toUpperCase();
  if (typeof value === 'number') custom_data.value = value;
  if (orderId) custom_data.order_id = String(orderId);
  if (contentIds?.length) custom_data.content_ids = contentIds;
  if (numItems) custom_data.num_items = numItems;
  if (contentIds?.length) custom_data.content_type = 'product';

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

  return sendEventToMetaWithRetry({ pixelId, accessToken, body, eventName });
}

// ---------- Webhook Handler ----------
async function handleStripeWebhook(req, res) {
  const stripeSecret   = process.env.STRIPE_SECRET_KEY;
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
  const pixelId        = process.env.FB_PIXEL_ID;
  const accessToken    = process.env.FB_ACCESS_TOKEN;
  const testEventCode  = process.env.FB_TEST_EVENT_CODE;

  if (!stripeSecret || !webhookSecret || !pixelId || !accessToken) {
    console.error('❌ Missing env vars.');
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
    'checkout.session.created',
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'payment_intent.succeeded',
    'invoice.payment_succeeded',
    'checkout.session.expired',
    'checkout.session.async_payment_failed',
    'customer.created',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'charge.refunded',
    'invoice.payment_failed',
    'payment_intent.payment_failed',
  ]);

  if (!handled.has(event.type)) {
    return res.json({ received: true });
  }

  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || undefined;

    let email = null;
    let amountMinor = null;
    let currency = 'USD';
    let orderId = null;
    let eventId = null;
    let eventName = null;
    let contentIds = [];
    let numItems = null;

    const obj = event.data.object;

    switch (event.type) {
      case 'checkout.session.created': {
        eventName = 'InitiateCheckout';
        eventId = obj.id;
        currency = (obj.currency || currency).toUpperCase();
        amountMinor = obj.amount_total ?? null;
        email = obj.customer_details?.email || obj.customer_email || null;
        orderId = obj.id;
        break;
      }

      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = await stripe.checkout.sessions.retrieve(obj.id, {
          expand: ['line_items', 'customer', 'payment_intent'],
        });
        eventName = 'Purchase';
        eventId = session.id;
        currency = session.currency || currency;
        amountMinor = session.amount_total ?? null;
        email = session.customer_details?.email || session.customer_email || null;
        orderId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || session.id;
        if (session.line_items?.data?.length) {
          contentIds = session.line_items.data.map(li => li.price?.product).filter(Boolean);
          numItems = session.line_items.data.reduce((sum, li) => sum + li.quantity, 0);
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = await stripe.paymentIntents.retrieve(obj.id, { expand: ['charges.data.billing_details'] });
        eventName = 'Purchase';
        eventId = pi.id;
        currency = pi.currency || currency;
        amountMinor = pi.amount ?? null;
        email = pi.charges?.data?.[0]?.billing_details?.email || null;
        orderId = pi.id;
        break;
      }

      case 'invoice.payment_succeeded': {
        eventName = 'Purchase';
        eventId = obj.id;
        currency = obj.currency || currency;
        amountMinor = obj.amount_paid ?? null;
        email = obj.customer_email || null;
        orderId = obj.id;
        break;
      }

      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        eventName = 'AbandonCheckout';
        eventId = obj.id;
        currency = obj.currency || currency;
        amountMinor = obj.amount_total ?? null;
        email = obj.customer_details?.email || obj.customer_email || null;
        orderId = obj.id;
        break;
      }

      case 'customer.created': {
        eventName = 'Lead';
        eventId = obj.id;
        email = obj.email || null;
        break;
      }

      case 'customer.subscription.created': {
        eventName = 'Subscribe';
        eventId = obj.id;
        email = obj.customer_email || null;
        orderId = obj.id;
        currency = obj.currency || currency;
        amountMinor = obj.items?.data?.[0]?.price?.unit_amount ?? null;
        break;
      }

      case 'customer.subscription.updated': {
        if (obj.status === 'active') {
          eventName = 'RenewSubscription';
        } else if (obj.status === 'past_due') {
          eventName = 'PaymentFailed';
        }
        eventId = obj.id;
        email = obj.customer_email || null;
        orderId = obj.id;
        break;
      }

      case 'customer.subscription.deleted': {
        eventName = 'CancelSubscription';
        eventId = obj.id;
        email = obj.customer_email || null;
        orderId = obj.id;
        break;
      }

      case 'charge.refunded': {
        eventName = 'Refund';
        eventId = obj.id;
        email = obj.billing_details?.email || null;
        currency = obj.currency || currency;
        amountMinor = obj.amount_refunded ?? null;
        orderId = obj.payment_intent || obj.id;
        break;
      }

      case 'invoice.payment_failed':
      case 'payment_intent.payment_failed': {
        eventName = 'PaymentFailed';
        eventId = obj.id;
        email = obj.customer_email || obj.charges?.data?.[0]?.billing_details?.email || null;
        orderId = obj.id;
        currency = obj.currency || currency;
        amountMinor = obj.amount_due ?? obj.amount ?? null;
        break;
      }
    }

    const value = convertAmount(amountMinor, currency);

    await sendEventToMeta({
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
      contentIds,
      numItems,
    });
  } catch (err) {
    console.error('❌ Error handling Stripe event:', err);
  }

  res.json({ received: true });
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
