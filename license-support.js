// license-support.js
// Endpoint de soporte: cambio de dispositivo (1 vez al año, manual)
// Protegido por token simple (cabecera X-Admin-Token)
//
// Requisitos ENV:
// - ADMIN_TOKEN   (secreto largo)
// - SUPPORT_EMAIL=contacto@tuappgo.com
//
// Requisitos:
// - Firestore en req.app.locals.db
// - Colección: licencias (docId = code)
//
// Ruta sugerida:
//   app.use(express.json());
//   app.post('/api/admin/licencia/cambiar-dispositivo', supportChangeDeviceHandler);

const { normalizeCode, isValidCodeFormat } = require('./license-code');

function nowDate() {
  return new Date();
}

function isExpired(expiresAt) {
  if (!expiresAt) return true;
  const d = expiresAt.toDate ? expiresAt.toDate() : new Date(expiresAt);
  return d.getTime() <= Date.now();
}

function ok(res, data) {
  return res.status(200).json({ ok: true, ...data });
}

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message });
}

function requireAdmin(req) {
  const expected = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (!expected) throw new Error('Falta ADMIN_TOKEN en el servidor');
  if (!provided || String(provided) !== String(expected)) return false;
  return true;
}

/**
 * Body:
 *  {
 *    "code": "XXXX-XXXX-XXXX",
 *    "newDeviceUuid": "....",
 *    "reason": "Cambio de ordenador"
 *  }
 */
async function supportChangeDeviceHandler(req, res) {
  if (!requireAdmin(req)) {
    return fail(res, 401, 'UNAUTHORIZED', 'No autorizado');
  }

  const db = req.app?.locals?.db;
  if (!db) return fail(res, 500, 'SERVER_CONFIG', 'Firestore db no configurado');

  const code = normalizeCode(req.body?.code);
  const newDeviceUuid = String(req.body?.newDeviceUuid || '').trim();
  const reason = String(req.body?.reason || '').trim().slice(0, 200);

  if (!code) return fail(res, 400, 'MISSING_CODE', 'Falta el código de licencia');
  if (!isValidCodeFormat(code)) return fail(res, 400, 'INVALID_CODE_FORMAT', 'Formato de código no válido');
  if (!newDeviceUuid) return fail(res, 400, 'MISSING_DEVICE', 'Falta el UUID nuevo del dispositivo');

  const ref = db.collection('licenses').doc(code);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { kind: 'error', status: 404, code: 'NOT_FOUND', message: 'Licencia no encontrada' };
      }

      const lic = snap.data() || {};
      const status = String(lic.status || '').toLowerCase();

      if (status !== 'active') {
        return { kind: 'error', status: 403, code: 'NOT_ACTIVE', message: 'La licencia no está activa' };
      }

      if (isExpired(lic.expiresAt)) {
        tx.update(ref, { status: 'expired', updatedAt: nowDate() });
        return { kind: 'error', status: 403, code: 'EXPIRED', message: 'Licencia caducada. No se puede cambiar dispositivo.' };
      }

      if (lic.deviceChangeUsed === true) {
        return {
          kind: 'error',
          status: 403,
          code: 'DEVICE_CHANGE_ALREADY_USED',
          message: 'El cambio de dispositivo anual ya fue utilizado.',
        };
      }

      const currentDevice = lic.deviceUuid ? String(lic.deviceUuid) : null;

      tx.update(ref, {
        deviceUuid: newDeviceUuid,
        // si nunca estuvo activada, marcamos activación; si ya lo estaba, solo cambio
        activatedAt: lic.activatedAt ? lic.activatedAt : nowDate(),
        deviceChangeUsed: true,
        deviceChangedAt: nowDate(),
        deviceChangeReason: reason || null,
        previousDeviceUuid: currentDevice || null,
        updatedAt: nowDate(),
      });

      return {
        kind: 'ok',
        code,
        previousDeviceUuid: currentDevice,
        newDeviceUuid,
        expiresAt: lic.expiresAt,
      };
    });

    if (result.kind === 'ok') {
      const expiresAt = result.expiresAt?.toDate ? result.expiresAt.toDate() : new Date(result.expiresAt);
      return ok(res, {
        license: {
          code: result.code,
          previousDeviceUuid: result.previousDeviceUuid,
          deviceUuid: result.newDeviceUuid,
          expiresAt: expiresAt.toISOString(),
          deviceChangeUsed: true,
        },
      });
    }

    return fail(res, result.status, result.code, result.message);
  } catch (err) {
    try {
      await ref.set({ lastError: String(err.message || err), updatedAt: nowDate() }, { merge: true });
    } catch (_) {}
    return fail(res, 500, 'SERVER_ERROR', 'Error interno al cambiar el dispositivo');
  }
}

module.exports = { supportChangeDeviceHandler };
