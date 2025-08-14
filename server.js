/**
 * Stripe -> Meta (Facebook) Conversions API bridge
 * Express server for Render (Node 18+)
 *
 * Endpoints:
 *   GET  /                  -> "OK" (health check)
 *   POST /stripe/webhook    -> receives Stripe events, forwards Purchase to Meta CAPI
 *
 * Env Vars (set in Render):
 *   STRIPE_SECRET_KEY       = sk_live_...
 *   STRIPE_WEBHOOK_SECRET   = whsec_...
 *   FB_PIXEL_ID             = 123456789012345
 *   FB_ACCESS_TOKEN         = EAAB...
 *   FB_TEST_EVENT_CODE      = TEST123 (optional, testing only)
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Stripe = require('stripe');

// Load .env in local dev (Render ignores .env and uses env vars)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();

// Raw body for Stripe signature verification ONLY on the webhook route
app.post('/stripe/webhook', express.raw({ type: 'application/json' }));

// JSON parsing for all other routes
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

function sha256Lower(input) {
  if (!input) return null;
  const normalized = String(input).trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function sendPurchaseToMeta({ pixelId, accessToken, eventId, email, value, currency, sourceUrl, ip, ua, testEventCode, orderId }) {
  const user_data = {};
  if (email) user_data.em = [sha256Lower(email)];
  if (ip) user_data.client_ip_address = ip;
  if (ua) user_data.client_user_agent = ua;

  const custom_data = {
    currency: String(currency || '').toUpperCase(),
    value: Number(value || 0),
  };
  if (orderId) custom_data.order_id = String(orderId);

  const body = {
    data: [
      {
        event_name: 'Purchase',
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

app.post('/stripe/webhook', async (req, res) => {
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const pixelId = process.env.FB_PIXEL_ID || process.env.META_PIXEL_ID;
  const accessToken = process.env.FB_ACCESS_TOKEN || process.env.FB_CAPI_TOKEN;
  const testEventCode = process.env.FB_TEST_EVENT_CODE;

  if (!stripeSecret || !webhookSecret || !pixelId || !accessToken) {
    console.error('❌ Missing required env vars. Check STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, FB_PIXEL_ID, FB_ACCESS_TOKEN/FB_CAPI_TOKEN');
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

  try {
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const session = event.data.object;

      // Retrieve full session to be safe (get email, amounts, currency, PI/order)
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['customer', 'payment_intent'],
      });

      const email =
        fullSession?.customer_details?.email ||
        fullSession?.customer?.email ||
        fullSession?.customer_email ||
        null;

      const amountTotal = fullSession?.amount_total ?? session?.amount_total;
      const currency = (fullSession?.currency || session?.currency || 'USD').toUpperCase();
      const value = amountTotal ? Number(amountTotal) / 100 : 0;

      const orderId =
        (typeof fullSession?.payment_intent === 'string'
          ? fullSession.payment_intent
          : fullSession?.payment_intent?.id) || fullSession?.id || session?.id;

      const eventId = session.id; // great for dedup with browser pixel if used
      const sourceUrl = 'https://pay.stripe.com'; // optional; helps attribution

      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const ua = req.headers['user-agent'];

      const result = await sendPurchaseToMeta({
        pixelId,
        accessToken,
        eventId,
        email,
        value,
        currency,
        sourceUrl,
        ip,
        ua,
        testEventCode,
        orderId,
      });

      if (result.status >= 200 && result.status < 300) {
        console.log('✅ Sent Purchase to Meta CAPI:', JSON.stringify(result.data));
      } else {
        console.error('⚠️ Meta CAPI responded with non-2xx:', result.status, result.data);
      }
    } else {
      // Not a handled event; ignore gracefully
      // console.log(`Ignoring event type ${event.type}`);
    }
  } catch (err) {
    console.error('❌ Error handling event:', err);
    // Do not fail the webhook delivery if CAPI fails—ack to Stripe to prevent retries storm.
  }

  res.json({ received: true });
});

// Render provides PORT via env
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
