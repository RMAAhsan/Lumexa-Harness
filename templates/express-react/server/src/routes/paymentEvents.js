/**
 * What happens when a payment completes. Called by Stripe's webhook, or
 * immediately by createCheckout() in simulated mode, with the same event shape:
 *
 *   event.type === 'checkout.session.completed'
 *   event.data.object: { id, payment_intent, amount_total, currency, metadata }
 *
 * Example: mark the booking in metadata.bookingId as paid and keep
 * payment_intent for refunds.
 */
// eslint-disable-next-line no-unused-vars
export async function handlePaymentEvent(event) {}
