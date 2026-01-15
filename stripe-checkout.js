// stripe-checkout.js
// Endpoint: crear sesión de Stripe Checkout (pago) para licencia anual (pago único)
//
// Requisitos ENV:
// - STRIPE_SECRET_KEY
// - STRIPE_PRICE_ID         (precio creado en Stripe)
// - CHECKOUT_SUCCESS_URL    (ej: https://tuappgo.com/pago-ok)
// - CHECKOUT_CANCEL_URL     (ej: https://tuappgo.com/pago-cancelado)
//
// Ruta sugerida:
//   app.post('/api/stripe/checkout', createCheckoutSessionHandler);

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
    const successUrl = requireEnv('CHECKOUT_SUCCESS_URL');
    const cancelUrl = requireEnv('CHECKOUT_CANCEL_URL');

    // Email opcional (si tu app lo pide antes). Si no lo envías, Stripe lo pedirá igualmente.
    const email = String(req.body?.email || '').trim().toLowerCase();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PRICE_ID, quantity: 1 }],

      // Si lo tienes, lo pre-rellenas. Si no, Stripe lo pedirá.
      customer_email: email || undefined,

      // Para que el webhook tenga el email
      // (Stripe normalmente lo incluye en customer_details.email)
      // y para UX de redirección.
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,

      // Puedes activar promociones/cupones si quieres
      allow_promotion_codes: true,

      // Metadatos útiles (opcionales)
      metadata: {
        product: 'tuappgo-licencia-anual',
      },
    });

    return res.status(200).json({
      ok: true,
      checkout: {
        sessionId: session.id,
        url: session.url, // redirige el frontend aquí
      },
    });
  } catch (err) {
    return fail(res, 500, 'CHECKOUT_ERROR', err.message || 'Error creando checkout');
  }
}

module.exports = { createCheckoutSessionHandler };
