// manual-payment.js
const admin = require('firebase-admin');

function genReferencia(prefix = 'TUAPP') {
  const rnd = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return `${prefix}-${rnd}`;
}

function safeTrim(v) {
  return String(v || '').trim();
}

function getPriceEurFromEnv() {
  // Ahora el precio oficial incluye el total con IVA y Retención (148,20)
  const p = Number(process.env.PRICE_EUR || 0);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

/**
 * Función auxiliar para obtener la Base Imponible desde Render
 */
function getBaseImponibleFromEnv() {
  const b = Number(process.env.PRECIO_BASE || 130.00);
  return Number.isFinite(b) ? b : 130.00;
}

/**
 * Genera el Bloque HTML de la factura desglosada (Usado para previsualización o emails)
 * Mejora 1: Logo 105px
 * Mejora 2: Orden descendente (Base, IVA, Ret, Total)
 */
function buildManualInvoiceHtml(invoiceData) {
  const emisor = {
    nombre: process.env.EMPRESA_NOMBRE || '',
    dni: process.env.EMPRESA_DNI || '',
    dir: process.env.EMPRESA_DIRECCION || '',
    tel: process.env.EMPRESA_TELEFONO || ''
  };

  return `
    <div style="margin-top:30px; border:1px solid #ddd; padding:20px; font-family:Arial, sans-serif; border-radius:8px; color:#333; max-width: 500px;">
      <table style="width:100%;">
        <tr>
          <td style="vertical-align:top;">
            <img src="https://tuappgo.com/contratos/assets/logo-tuappgo.png" alt="TuAppGo" style="height:105px;">
          </td>
          <td style="text-align:right; font-size:12px; color:#555;">
            <strong>EMISOR:</strong><br>${emisor.nombre}<br>${emisor.dni}<br>${emisor.dir}<br>${emisor.tel}
          </td>
        </tr>
      </table>
      
      <div style="margin-top:20px;">
        <h3 style="margin-bottom:5px; color:#1a1a1a;">FACTURA: ${invoiceData.numero || 'PROVISIONAL'}</h3>
        <p style="font-size:13px; margin-top:0;">Fecha: ${invoiceData.fecha}</p>
      </div>

      <table style="width:100%; border-collapse:collapse; margin-top:15px; font-size:15px;">
        <tr>
          <td style="padding:10px 0; border-bottom:1px solid #eee;">Base Imponible</td>
          <td style="padding:10px 0; border-bottom:1px solid #eee; text-align:right;">${invoiceData.base}€</td>
        </tr>
        <tr>
          <td style="padding:10px 0; border-bottom:1px solid #eee;">IVA (${invoiceData.ivaPerc}%)</td>
          <td style="padding:10px 0; border-bottom:1px solid #eee; text-align:right;">${invoiceData.iva}€</td>
        </tr>
        <tr>
          <td style="padding:10px 0; border-bottom:1px solid #eee;">Retención IRPF (-${invoiceData.retPerc}%)</td>
          <td style="padding:10px 0; border-bottom:1px solid #eee; text-align:right; color:#d9534f;">-${invoiceData.ret}€</td>
        </tr>
        <tr style="font-weight:bold; background:#f9f9f9;">
          <td style="padding:12px 5px; font-size:1.1em;">TOTAL</td>
          <td style="padding:12px 5px; text-align:right; font-size:1.1em; color:#28a745;">${invoiceData.total}€</td>
        </tr>
      </table>
    </div>
  `;
}

async function createManualOrderHandler(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(503).json({ ok: false, code: 'FIRESTORE_NOT_READY' });

    const metodo = safeTrim(req.body?.metodo).toLowerCase(); // 'bizum' | 'transferencia'
    const email = safeTrim(req.body?.email);
    const uuid = safeTrim(req.body?.uuid);
    const producto = safeTrim(req.body?.producto || 'contratos');

    if (!['bizum', 'transferencia'].includes(metodo)) {
      return res.status(400).json({ ok: false, code: 'INVALID_METHOD' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ ok: false, code: 'INVALID_EMAIL' });
    }

    // ✅ IMPORTE OFICIAL (Debe ser 148,20 en Render)
    const envPrice = getPriceEurFromEnv();
    const amount = envPrice > 0 ? envPrice : 0;

    const prefix = metodo === 'bizum' ? 'TUAPP-BIZ' : 'TUAPP-TRF';
    const referencia = genReferencia(prefix);

    const bizumPhone = safeTrim(process.env.BIZUM_PHONE);
    const bankIban = safeTrim(process.env.BANK_IBAN);
    const bankHolder = safeTrim(process.env.BANK_HOLDER);
    const bankConceptHint = safeTrim(process.env.BANK_CONCEPT_HINT);

    if (metodo === 'bizum' && !bizumPhone) {
      return res.status(500).json({ ok: false, code: 'BIZUM_PHONE_NOT_SET' });
    }
    if (metodo === 'transferencia' && !bankIban) {
      return res.status(500).json({ ok: false, code: 'BANK_IBAN_NOT_SET' });
    }
    if (amount <= 0) {
      return res.status(500).json({ ok: false, code: 'PRICE_EUR_NOT_SET' });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    // ✅ Usamos la variable PRECIO_BASE para el desglose
    const baseVal = getBaseImponibleFromEnv();
    const ivaPerc = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retPerc = parseFloat(process.env.RETENCION_PORCENTAJE || '7');

    const doc = {
      metodo,
      email: email.toLowerCase(),
      uuid: uuid || null,
      producto,
      amount,
      currency: 'EUR',
      referencia,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      // Guardamos valores dinámicos basados en PRECIO_BASE
      baseImponible: baseVal,
      ivaPerc: ivaPerc,
      retPerc: retPerc
    };

    const ref = await db.collection('manual_orders').add(doc);

    const base = { metodo, referencia, amount, currency: 'EUR' };
    const instrucciones =
      metodo === 'bizum'
        ? { ...base, bizumPhone }
        : { ...base, bankIban, bankHolder, bankConceptHint };

    return res.json({ ok: true, orderId: ref.id, instrucciones });
  } catch (err) {
    console.error('❌ createManualOrderHandler error:', err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR' });
  }
}

module.exports = { createManualOrderHandler };
