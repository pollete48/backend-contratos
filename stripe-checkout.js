// stripe-checkout.js
// Endpoint: crear sesión de Stripe Checkout (pago) para licencia anual (pago único)
//
// Requisitos ENV:
// - STRIPE_SECRET_KEY
// - STRIPE_PRICE_ID
// - STRIPE_IVA_ID
// - CHECKOUT_SUCCESS_URL
// - CHECKOUT_CANCEL_URL
//
// Ruta sugerida:
//    app.post('/api/stripe/checkout', createCheckoutSessionHandler);

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

/**
 * Limpia URL de entorno:
 * - trim
 * - elimina espacios
 * - elimina query ?session_id=... si ya lo hubieran puesto en env
 * - elimina "#" final suelto
 */
function sanitizeBaseUrl(raw) {
  const s = String(raw || '').trim();

  // Si alguien metió ?session_id=... en la env, lo quitamos para no duplicarlo
  const noQuery = s.split('?')[0];

  // Quita un # final suelto (por si alguien puso .../#)
  const cleaned = noQuery.endsWith('#') ? noQuery.slice(0, -1) : noQuery;

  return cleaned;
}

/**
 * Construye success_url final añadiendo session_id.
 */
function buildSuccessUrlWithSessionId(successBase) {
  const base = sanitizeBaseUrl(successBase);

  // Si hay hash, la query debe ir antes del hash
  const [beforeHash, afterHash] = base.split('#');

  const withQuery = `${beforeHash}?session_id={CHECKOUT_SESSION_ID}`;

  // Si había hash, lo reponemos
  return afterHash !== undefined ? `${withQuery}#${afterHash}` : withQuery;
}

async function createCheckoutSessionHandler(req, res) {
  try {
    const PRICE_ID = requireEnv('STRIPE_PRICE_ID');
    const IVA_ID = requireEnv('STRIPE_IVA_ID');
    const successEnv = requireEnv('CHECKOUT_SUCCESS_URL');
    const cancelEnv = requireEnv('CHECKOUT_CANCEL_URL');

    const successUrlFinal = buildSuccessUrlWithSessionId(successEnv);
    const cancelUrlFinal = sanitizeBaseUrl(cancelEnv);

    // LOGS (para verificar en Render)
    console.log('[checkout] Iniciando sesión con IVA:', IVA_ID);

    // Email opcional
    const email = String(req.body?.email || '').trim().toLowerCase();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ 
        price: PRICE_ID, 
        quantity: 1,
        tax_rates: [IVA_ID] 
      }],
      
      // Aplicamos la retención mediante el Cupón manual de Stripe
      discounts: [{
        coupon: 'retencion_irpf', 
      }],

      customer_email: email || undefined,

      // Activamos factura para desglose de IVA y Retención
      invoice_creation: {
        enabled: true,
      },

      success_url: successUrlFinal,
      cancel_url: cancelUrlFinal,

      // Desactivamos códigos promocionales para evitar conflictos con la retención
      allow_promotion_codes: false,

      metadata: {
        product: 'tuappgo-licencia-anual',
      },
    });

    return res.status(200).json({
      ok: true,
      checkout: {
        sessionId: session.id,
        url: session.url,
      },
    });
  } catch (err) {
    console.error('[checkout] ERROR:', err);
    return fail(res, 500, 'CHECKOUT_ERROR', err.message || 'Error creando checkout');
  }
}

module.exports = { createCheckoutSessionHandler };
