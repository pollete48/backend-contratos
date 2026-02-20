// stripe-checkout.js
// Endpoint: crear sesión de Stripe Checkout (pago) para licencia anual (pago único)
//
// Requisitos ENV:
// - STRIPE_SECRET_KEY
// - STRIPE_PRICE_ID
// - STRIPE_IVA_ID
// - RETENCION_PORCENTAJE (ej: -7)
// - CHECKOUT_SUCCESS_URL
// - CHECKOUT_CANCEL_URL

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

function buildSuccessUrlWithSessionId(successBase) {
  const base = sanitizeBaseUrl(successBase);
  const [beforeHash, afterHash] = base.split('#');
  const withQuery = `${beforeHash}?session_id={CHECKOUT_SESSION_ID}`;
  return afterHash !== undefined ? `${withQuery}#${afterHash}` : withQuery;
}

async function createCheckoutSessionHandler(req, res) {
  try {
    const PRICE_ID = requireEnv('STRIPE_PRICE_ID');
    const IVA_ID = requireEnv('STRIPE_IVA_ID');
    const PORCENTAJE_RET = parseFloat(process.env.RETENCION_PORCENTAJE || '0');
    
    const successEnv = requireEnv('CHECKOUT_SUCCESS_URL');
    const cancelEnv = requireEnv('CHECKOUT_CANCEL_URL');

    const successUrlFinal = buildSuccessUrlWithSessionId(successEnv);
    const cancelUrlFinal = sanitizeBaseUrl(cancelEnv);

    // 1. Obtenemos el precio base para calcular la retención exacta
    const price = await stripe.prices.retrieve(PRICE_ID);
    const unitAmount = price.unit_amount; // Ej: 13000 (en céntimos)

    // 2. Definimos los line_items. Empezamos con el producto principal e IVA
    const lineItems = [
      {
        price: PRICE_ID,
        quantity: 1,
        tax_rates: [IVA_ID],
      }
    ];

    // 3. Si hay retención, la añadimos como una línea de descuento manual
    // Esto evita los problemas de los Tax Rates negativos en el Dashboard
    if (PORCENTAJE_RET !== 0) {
      const discountAmount = Math.round(unitAmount * (Math.abs(PORCENTAJE_RET) / 100));
      
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Retención IRPF (${Math.abs(PORCENTAJE_RET)}%)`,
            description: 'Deducción profesional aplicada sobre la base imponible',
          },
          unit_amount: -discountAmount, // Valor negativo para restar
        },
        quantity: 1,
      });
    }

    const email = String(req.body?.email || '').trim().toLowerCase();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_email: email || undefined,
      invoice_creation: {
        enabled: true,
      },
      success_url: successUrlFinal,
      cancel_url: cancelUrlFinal,
      allow_promotion_codes: true,
      metadata: {
        product: 'tuappgo-licencia-anual',
        retencion_aplicada: `${PORCENTAJE_RET}%`
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
