// stripe-checkout.js
// Endpoint: crear sesión de Stripe Checkout (pago) para licencia anual (pago único)
//
// Requisitos ENV:
// - STRIPE_SECRET_KEY
// - STRIPE_PRICE_ID

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message });
}

async function createCheckoutSessionHandler(req, res) {
  try {
    const PRICE_ID = requireEnv('STRIPE_PRICE_ID');

    // ✅ FORZADO A TU PROGRAMA (NO depende de env, no puede “irse a la web”)
    const success_url = `https://tuappgo.com/contratos/#/pago-ok?session_id={CHECKOUT_SESSION_ID}`;
    const cancel_url  = `https://tuappgo.com/contratos/#/pago-cancelado`;

    console.log('[checkout] success_url FINAL:', success_url);
    console.log('[checkout] cancel_url FINAL:', cancel_url);

    const email = String(req.body?.email || '').trim().toLowerCase();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      customer_email: email || undefined,
      success_url,
      cancel_url,
      allow_promotion_codes: true,
      metadata: { product: 'tuappgo-licencia-anual' },
    });

    return res.status(200).json({
      ok: true,
      checkout: { sessionId: session.id, url: session.url },
    });
  } catch (err) {
    console.error('[checkout] ERROR:', err);
    return fail(res, 500, 'CHECKOUT_ERROR', err.message || 'Error creando checkout');
  }
}

module.exports = { createCheckoutSessionHandler };
