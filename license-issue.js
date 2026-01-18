// license-issue.js
// Genera un código ÚNICO comprobando Firestore con docId = code (colección: licencias)

const { generateLicenseCode } = require('./license-code');

/**
 * Genera un código de licencia único contra Firestore.
 *
 * Requisitos:
 * - En Firestore, las licencias están en la colección "licencias"
 * - El docId es el propio code (ej: licencias/{code})
 *
 * @param {import('firebase-admin/firestore').Firestore} db - instancia de Firestore (firebase-admin)
 * @param {object} [opts]
 * @param {string} [opts.collectionName="licencias"]
 * @param {number} [opts.maxAttempts=20]
 * @returns {Promise<string>} code único
 */
async function generateUniqueLicenseCode(db, opts = {}) {
  if (!db) throw new Error('Firestore db requerido');

  const collectionName = opts.collectionName || 'licenses';
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 20;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const code = generateLicenseCode();

    // Como docId = code, la comprobación es directa
    const ref = db.collection(collectionName).doc(code);
    const snap = await ref.get();

    if (!snap.exists) return code;
  }

  throw new Error(`No se pudo generar un código único tras ${maxAttempts} intentos`);
}

/**
 * Crea (emite) una licencia nueva en Firestore (documento completo) usando un code único.
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {object} input
 * @param {string} input.email
 * @param {string} input.stripeSessionId
 * @param {string} [input.paymentIntentId]
 * @param {number} input.amountTotal
 * @param {string} input.currency
 * @param {Date} [input.paidAt]  - si no se indica, usa ahora
 * @param {string} [input.collectionName="licencias"]
 * @returns {Promise<{code: string, refPath: string}>}
 */
async function createLicenseFromStripe(db, input) {
  const {
    email,
    stripeSessionId,
    paymentIntentId = null,
    amountTotal,
    currency,
    paidAt = new Date(),
    collectionName = 'licenses',
  } = input || {};

  if (!email) throw new Error('email requerido');
  if (!stripeSessionId) throw new Error('stripeSessionId requerido');
  if (!Number.isFinite(amountTotal)) throw new Error('amountTotal requerido');
  if (!currency) throw new Error('currency requerida');

  const normalizedEmail = String(email).trim().toLowerCase();

  const code = await generateUniqueLicenseCode(db, { collectionName });

  const admin = require('firebase-admin');

const paidAtDate = paidAt instanceof Date ? paidAt : new Date(paidAt);
const expiresAtDate = new Date(paidAtDate);
expiresAtDate.setFullYear(expiresAtDate.getFullYear() + 1);

const paidAtTs = admin.firestore.Timestamp.fromDate(paidAtDate);
const expiresAtTs = admin.firestore.Timestamp.fromDate(expiresAtDate);

  const doc = {
    code,
    email: normalizedEmail,
    status: 'active',

    createdAt: admin.firestore.FieldValue.serverTimestamp(),
paidAt: paidAtTs,
expiresAt: expiresAtTs,

    deviceUuid: null,
    activatedAt: null,
    deviceChangeUsed: false,
    deviceChangedAt: null,

    recoveryUsed: false,
    recoveryUsedAt: null,

    stripe: {
      sessionId: stripeSessionId,
      paymentIntentId,
      amountTotal,
      currency,
      customerId: null,
      receiptUrl: null,
    },

    webhookProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastError: null,
    source: 'stripe',
  };

  const ref = db.collection(collectionName).doc(code);

  // Creamos en una transacción por seguridad (evita colisiones raras)
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) throw new Error('Colisión inesperada: el código ya existe');
    tx.create(ref, doc);
  });

  return { code, expiresAt: expiresAtDate, refPath: ref.path };
}

module.exports = {
  generateUniqueLicenseCode,
  createLicenseFromStripe,
};

