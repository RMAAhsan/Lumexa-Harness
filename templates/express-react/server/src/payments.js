/**
 * Payments through Stripe Checkout, with a simulated mode when STRIPE_SECRET_KEY
 * is not set (local dev, tests, demos): the checkout "succeeds" immediately and
 * the same handlePaymentEvent() runs, so the app behaves identically.
 *
 *   const { url } = await createCheckout({
 *     amountCents: 51000, currency: 'eur', description: 'Beginner course',
 *     metadata: { bookingId: String(booking.id) },
 *     successPath: `/bookings/${booking.id}?paid=1`, cancelPath: `/bookings/${booking.id}`,
 *   });
 *   // web: window.location.href = url   mobile: WebBrowser.openBrowserAsync(url)
 *
 *   await refund({ paymentIntentId, amountCents })   // partial or full
 *
 * Put what should happen when a payment completes (mark a booking paid, store the
 * paymentIntentId for refunds, send a notification) in routes/paymentEvents.js.
 */
import crypto from 'node:crypto';
import Stripe from 'stripe';
import { handlePaymentEvent } from './routes/paymentEvents.js';

const key = process.env.STRIPE_SECRET_KEY;
export const stripe = key ? new Stripe(key) : null;
export const paymentsMode = stripe ? 'stripe' : 'simulated';

const appUrl = () => (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');

export async function createCheckout({ amountCents, currency = 'eur', description, metadata = {}, successPath = '/', cancelPath = '/' }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw Object.assign(new Error('amount must be a positive integer of cents'), { status: 400 });
  if (!stripe) {
    const sessionId = `sim_cs_${crypto.randomUUID()}`;
    await handlePaymentEvent({
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_intent: `sim_pi_${crypto.randomUUID()}`, amount_total: amountCents, currency, metadata } },
    });
    return { url: `${appUrl()}${successPath}`, sessionId, mode: paymentsMode };
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency, unit_amount: amountCents, product_data: { name: description } } }],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${appUrl()}${successPath}`,
    cancel_url: `${appUrl()}${cancelPath}`,
  });
  return { url: session.url, sessionId: session.id, mode: paymentsMode };
}

export async function refund({ paymentIntentId, amountCents }) {
  if (!stripe) return { id: `sim_re_${crypto.randomUUID()}`, status: 'succeeded', amount: amountCents };
  const r = await stripe.refunds.create({ payment_intent: paymentIntentId, ...(amountCents ? { amount: amountCents } : {}) });
  return { id: r.id, status: r.status, amount: r.amount };
}

/** Express handler for POST /api/payments/webhook (mounted with a raw body in app.js). */
export async function stripeWebhook(req, res) {
  if (!stripe) return res.status(404).json({ error: 'Payments are in simulated mode' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature check failed: ${err.message}` });
  }
  await handlePaymentEvent(event);
  res.json({ received: true });
}
