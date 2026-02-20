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

/**
 * Obtiene o crea el Tax Rate basado en la variable de entorno
 */
async function getOrCreateRetencionTaxRate(valorPorcentaje) {
  try {
    const numPorcentaje = parseFloat(valorPorcentaje);
    if (isNaN(numPorcentaje)) return null;

    const taxRates = await stripe.taxRates.list({ active: true, limit: 100 });
    // Buscamos si existe un impuesto con ese porcentaje exacto y nombre de retención
    const existing = taxRates.data.find(tr => tr.percentage === numPorcentaje && tr.display_name.includes('Retención'));
    
    if (existing) return existing.id;

    // Si no existe, lo creamos dinámicamente
    const newTaxRate = await stripe.taxRates.create({
      display_name: 'Retención IRPF',
      description: `Retención ${Math.abs(numPorcentaje)}% (aplicada automáticamente)`,
      percentage: numPorcentaje,
      inclusive: false,
      jurisdiction: 'ES',
    });
    return newTaxRate.id;
  } catch (error) {
    console.error('[getOrCreateRetencionTaxRate] Error:', error.message);
    return null;
  }
}

async function createCheckoutSessionHandler(req, res) {
  try {
    const PRICE_ID = requireEnv('STRIPE_PRICE_ID');
    const IVA_ID = requireEnv('STRIPE_IVA_ID');
    const PORCENTAJE_RET = process.env.RETENCION_PORCENTAJE; // No usamos requireEnv para que sea opcional
    
    const successEnv = requireEnv('CHECKOUT_SUCCESS_URL');
    const cancelEnv = requireEnv('CHECKOUT_CANCEL_URL');

    const successUrlFinal = buildSuccessUrlWithSessionId(successEnv);
    const cancelUrlFinal = sanitizeBaseUrl(cancelEnv);

    // Lista de impuestos a aplicar
    const activeTaxRates = [IVA_ID];

    // Si existe la variable de retención, buscamos o creamos el ID
    if (PORCENTAJE_RET) {
      const RETENCION_ID = await getOrCreateRetencionTaxRate(PORCENTAJE_RET);
      if (RETENCION_ID) {
        activeTaxRates.push(RETENCION_ID);
      }
    }

    console.log('[checkout] Impuestos finales a aplicar:', activeTaxRates);

    const email = String(req.body?.email || '').trim().toLowerCase();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ 
        price: PRICE_ID, 
        quantity: 1,
        tax_rates: activeTaxRates
      }],
      customer_email: email || undefined,
      invoice_creation: {
        enabled: true,
      },
      success_url: successUrlFinal,
      cancel_url: cancelUrlFinal,
      allow_promotion_codes: true,
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
