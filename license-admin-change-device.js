// license-admin-change-device.js
// Endpoint ADMIN: permitir 1 cambio de dispositivo por licencia (anual)

const admin = require('firebase-admin');

function requireAdmin(req) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
}

function isExpired(expiresAt) {
  if (!expiresAt) return true;
  const d = expiresAt.toDate ? expiresAt.toDate() : new Date(expiresAt);
  return d.getTime() <= Date.now();
}

/**
 * Body:
 * {
 *   "code": "XXXX-XXXX-XXXX",
 *   "newDeviceUuid": "uuid-nuevo"
 * }
 */
async function adminChangeDeviceHandler(req, res) {
  try {
    requireAdmin(req);

    const db = req.app?.locals?.db;
    if (!db) return res.status(500).json({ ok: false, code: 'SERVER_CONFIG' });

    const code = String(req.body?.code || '').trim().toUpperCase();
    const newDeviceUuid = String(req.body?.newDeviceUuid || '').trim();

    if (!code || !newDeviceUuid) {
      return res.status(400).json({ ok: false, code: 'MISSING_FIELDS' });
    }

    const ref = db.collection('licenses').doc(code);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('NOT_FOUND');

      const lic = snap.data() || {};

      if (String(lic.status) !== 'active') throw new Error('NOT_ACTIVE');
      if (isExpired(lic.expiresAt)) throw new Error('EXPIRED');

      // Regla: 1 cambio de dispositivo cada 365 días
const lastChangedAt =
  lic.deviceChangedAt?.toDate
    ? lic.deviceChangedAt.toDate()
    : (lic.deviceChangedAt ? new Date(lic.deviceChangedAt) : null);

// Si por compatibilidad antigua existe el flag pero no hay fecha, se mantiene el bloqueo (no podemos calcular el año)
if (lic.deviceChangeUsed === true && !lastChangedAt) {
  throw new Error('DEVICE_CHANGE_ALREADY_USED');
}

if (lastChangedAt) {
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const elapsed = Date.now() - lastChangedAt.getTime();
  if (elapsed < ONE_YEAR_MS) {
    throw new Error('DEVICE_CHANGE_TOO_SOON');
  }
}

      tx.update(ref, {
        deviceUuid: newDeviceUuid,
        deviceChangeUsed: true,
        deviceChangedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.json({ ok: true });
  } catch (err) {
    const code = err.message || 'ERROR';
    const status = err.status || 403;

    return res.status(status).json({ ok: false, code });
  }
}

module.exports = { adminChangeDeviceHandler };
