// stripe-checkout.js
// Endpoint: crear sesión de Stripe Checkout (pago) para licencia anual (pago único)
//
// Requisitos ENV:
// - STRIPE_SECRET_KEY
// - STRIPE_PRICE_ID
// - CHECKOUT_SUCCESS_URL    (ideal: https://tuappgo.com/contratos/#/pago-ok)
// - CHECKOUT_CANCEL_URL     (ideal: https://tuappgo.com/contratos/#/pago-cancelado)

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

function stripQueryAndTrim(url) {
  return String(url || '').trim().split('?')[0];
}

/**
 * Normaliza para que SIEMPRE vuelva a:
 *   https://tuappgo.com/contratos/#/ruta
 *
 * Corrige casos típicos:
 * - https://tuappgo.com/#/pago-ok           -> https://tuappgo.com/contratos/#/pago-ok
 * - https://www.tuappgo.com/#/pago-ok       -> https://www.tuappgo.com/contratos/#/pago-ok
 * - .../contratos/ajustes...                -> (rechazamos)
 */
function normalizeToContratosHashRoute(rawUrl) {
  const base = stripQueryAndTrim(rawUrl);

  // Bloqueo duro si alguien mete /ajustes por error
  if (base.includes('/ajustes')) {
    throw new Error(`CHECKOUT URL inválida (contiene /ajustes): ${base}`);
  }

  // Si ya tiene /contratos/#/..., perfecto
  if (base.includes('/contratos/#/')) return base;

  // Si es tu dominio y viene como /#/..., insertamos /contratos/
  // https://tuappgo.com/#/pago-ok  -> https://tuappgo.com/contratos/#/pago-ok
  const m = base.match(/^(https?:\/\/(?:www\.)?tuappgo\.com)\/#\/(.+)$/i);
  if (m) return `${m[1]}/contratos/#/${m[2]}`;

  // Si viene como https://tuappgo.com/contratos (sin /#/), no sirve para tu routing
  // pero lo intentamos “arreglar” si acaba en /contratos/#/...
  if (base.endsWith('/contratos/#/pago-ok') || base.endsWith('/contratos/#/pago-cancelado')) {
    return base;
  }

  // Si no podemos garantizar, mejor fallar con error claro
  throw new Error(`CHECKOUT URL inválida para tu app (debe ser /contratos/#/...): ${base}`);
}

function addSessionIdToHashRoute(successUrlBase) {
  // Para Angular hash routing, el session_id debe ir DESPUÉS de la ruta hash
  // https://.../contratos/#/pago-ok?session_id=...
  return `${successUrlBase}?session_id={CHECKOUT_SESSION_ID}`;
}

async function createCheckoutSessionHandler(req, res) {
  try {
    const PRICE_ID = requireEnv('STRIPE_PRICE_ID');
    const successEnv = requireEnv('CHECKOUT_SUCCESS_URL');
    const cancelEnv = requireEnv('CHECKOUT_CANCEL_URL');

    const successBase = normalizeToContratosHashRoute(successEnv);
    const cancelBase = normalizeToContratosHashRoute(cancelEnv);

    const successUrlFinal = `${successBase}?from=BACKEND_V2&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrlFinal = cancelBase;

    // LOGS CLAROS
    console.log('[checkout] CHECKOUT_SUCCESS_URL env:', successEnv);
    console.log('[checkout] CHECKOUT_CANCEL_URL env:', cancelEnv);
    console.log('[checkout] success_url FINAL:', successUrlFinal);
    console.log('[checkout] cancel_url FINAL:', cancelUrlFinal);

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

