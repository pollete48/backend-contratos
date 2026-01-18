// stripe-checkout.js
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

function sanitizeBaseUrl(raw) {
  const s = String(raw || '').trim();
  const noQuery = s.split('?')[0];
  const cleaned = noQuery.endsWith('#') ? noQuery.slice(0, -1) : noQuery;
  return cleaned;
}

// ✅ CORREGIDO para Ionic/Angular hash routing:
// deja el session_id DESPUÉS del #/pago-ok
function buildSuccessUrlWithSessionId(successBase) {
  const base = sanitizeBaseUrl(successBase);
  return `${base}?session_id={CHECKOUT_SESSION_ID}`;
}

async function createCheckoutSessionHandler(req, res) {
  try {
    const PRICE_ID = requireEnv('STRIPE_PRICE_ID');
    const successEnv = requireEnv('CHECKOUT_SUCCESS_URL');
    const cancelEnv = requireEnv('CHECKOUT_CANCEL_URL');

    const successUrlFinal = buildSuccessUrlWithSessionId(successEnv);
    const cancelUrlFinal = sanitizeBaseUrl(cancelEnv);

    console.log('[checkout] CHECKOUT_SUCCESS_URL env:', successEnv);
    console.log('[checkout] CHECKOUT_CANCEL_URL env:', cancelEnv);
    console.log('[checkout] success_url final:', successUrlFinal);
    console.log('[checkout] cancel_url final:', cancelUrlFinal);

    const email = String(req.body?.email || '').trim().toLowerCase();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      customer_email: email || undefined,
      success_url: successUrlFinal,
      cancel_url: cancelUrlFinal,
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
