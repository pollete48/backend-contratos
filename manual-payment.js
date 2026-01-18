const admin = require('firebase-admin');

function genReferencia(prefix = 'TUAPP') {
  // Referencia corta, legible y casi única
  // Ej: TUAPP-BIZ-7K3Q9P
  const rnd = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return `${prefix}-${rnd}`;
}

function safeTrim(v) {
  return String(v || '').trim();
}

async function createManualOrderHandler(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(503).json({ ok: false, code: 'FIRESTORE_NOT_READY' });

    const metodo = safeTrim(req.body?.metodo).toLowerCase(); // 'bizum' | 'transferencia'
    const email = safeTrim(req.body?.email);
    const uuid = safeTrim(req.body?.uuid); // opcional pero útil
    const producto = safeTrim(req.body?.producto || 'contratos');
    const amount = Number(req.body?.amount || 0);

    if (!['bizum', 'transferencia'].includes(metodo)) {
      return res.status(400).json({ ok: false, code: 'INVALID_METHOD' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ ok: false, code: 'INVALID_EMAIL' });
    }

    const prefix = metodo === 'bizum' ? 'TUAPP-BIZ' : 'TUAPP-TRF';
    const referencia = genReferencia(prefix);

    // Datos de pago desde variables de entorno (Render)
    const bizumPhone = safeTrim(process.env.BIZUM_PHONE);
    const bankIban = safeTrim(process.env.BANK_IBAN);
    const bankHolder = safeTrim(process.env.BANK_HOLDER);
    const bankConceptHint = safeTrim(process.env.BANK_CONCEPT_HINT); // opcional

    if (metodo === 'bizum' && !bizumPhone) {
      return res.status(500).json({ ok: false, code: 'BIZUM_PHONE_NOT_SET' });
    }
    if (metodo === 'transferencia' && !bankIban) {
      return res.status(500).json({ ok: false, code: 'BANK_IBAN_NOT_SET' });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    const doc = {
      metodo,
      email: email.toLowerCase(),
      uuid: uuid || null,
      producto,
      amount: Number.isFinite(amount) ? amount : 0,
      currency: 'EUR',
      referencia,
      status: 'pending', // pending -> (manual) paid -> license_sent
      createdAt: now,
      updatedAt: now,
    };

    const ref = await db.collection('manual_orders').add(doc);

    const instrucciones = {
      metodo,
      referencia,
      ...(metodo === 'bizum'
        ? { bizumPhone }
        : { bankIban, bankHolder, bankConceptHint }),
    };

    return res.json({
      ok: true,
      orderId: ref.id,
      instrucciones,
    });
  } catch (err) {
    console.error('❌ createManualOrderHandler error:', err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR' });
  }
}

module.exports = { createManualOrderHandler };
