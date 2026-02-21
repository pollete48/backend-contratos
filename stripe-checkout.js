// stripe-checkout.js
// Endpoint: crear sesión de Stripe Checkout (pago) para licencia anual (pago único)
//
// Requisitos ENV:
// - STRIPE_SECRET_KEY
// - STRIPE_PRICE_ID_PARTICULAR (130 + IVA = 157,30€)
// - STRIPE_PRICE_ID_PROFESIONAL (130 + IVA - 7% = 148,20€)
// - CHECKOUT_SUCCESS_URL    (ej: https://tuappgo.com/contratos/#/pago-ok)
// - CHECKOUT_CANCEL_URL      (ej: https://tuappgo.com/contratos/#/pago-cancelado)

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
 * Limpia URL de entorno
 */
function sanitizeBaseUrl(raw) {
  const s = String(raw || '').trim();
  const noQuery = s.split('?')[0];
  const cleaned = noQuery.endsWith('#') ? noQuery.slice(0, -1) : noQuery;
  return cleaned;
}

/**
 * Construye success_url final añadiendo session_id
 */
function buildSuccessUrlWithSessionId(successBase) {
  const base = sanitizeBaseUrl(successBase);
  const [beforeHash, afterHash] = base.split('#');
  const withQuery = `${beforeHash}?session_id={CHECKOUT_SESSION_ID}`;
  return afterHash !== undefined ? `${withQuery}#${afterHash}` : withQuery;
}

async function createCheckoutSessionHandler(req, res) {
  try {
    const successEnv = requireEnv('CHECKOUT_SUCCESS_URL');
    const cancelEnv = requireEnv('CHECKOUT_CANCEL_URL');

    const successUrlFinal = buildSuccessUrlWithSessionId(successEnv);
    const cancelUrlFinal = sanitizeBaseUrl(cancelEnv);

    // Datos que vienen del frontend (Modal)
    const email = String(req.body?.email || '').trim().toLowerCase();
    const tipoCliente = req.body?.tipoCliente || 'particular'; // 'particular' | 'profesional'
    const nombreFactura = req.body?.nombreFactura || '';
    const nifFactura = req.body?.nifFactura || '';
    const direccionFactura = req.body?.direccionFactura || '';

    // SELECCIÓN DINÁMICA DEL PRECIO (Estrategia Fiscal 70%)
    let PRICE_ID;
    if (tipoCliente === 'profesional') {
      PRICE_ID = requireEnv('STRIPE_PRICE_ID_PROFESIONAL');
    } else {
      PRICE_ID = requireEnv('STRIPE_PRICE_ID_PARTICULAR');
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PRICE_ID, quantity: 1 }],

      customer_email: email || undefined,

      invoice_creation: {
        enabled: true,
      },

      success_url: successUrlFinal,
      cancel_url: cancelUrlFinal,

      allow_promotion_codes: true,

      // METADATOS: Crucial para que el webhook genere la factura correcta
      metadata: {
        product: 'tuappgo-licencia-anual',
        tipoCliente: tipoCliente,
        nombreFactura: nombreFactura,
        nifFactura: nifFactura,
        direccionFactura: direccionFactura
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
