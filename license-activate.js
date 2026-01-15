// license-activate.js
// Endpoint: activar licencia (código + UUID del dispositivo)
//
// Requisitos:
// - Firestore en req.app.locals.db (firebase-admin)
// - Colección: licencias (docId = code)
//
// Ruta sugerida en Express:
//   app.use(express.json());
//   app.post('/api/licencia/activar', activateLicenseHandler);

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

function fail(res, status, code, message, extra) {
  return res.status(status).json({ ok: false, code, message, ...(extra || {}) });
}

/**
 * Body:
 *  {
 *    "code": "XXXX-XXXX-XXXX",
 *    "deviceUuid": "...."
 *  }
 */
async function activateLicenseHandler(req, res) {
  const db = req.app?.locals?.db;
  if (!db) return fail(res, 500, 'SERVER_CONFIG', 'Firestore db no configurado');

  const rawCode = req.body?.code;
  const deviceUuid = String(req.body?.deviceUuid || '').trim();

  const code = normalizeCode(rawCode);

  if (!code) return fail(res, 400, 'MISSING_CODE', 'Falta el código de licencia');
  if (!isValidCodeFormat(code)) return fail(res, 400, 'INVALID_CODE_FORMAT', 'Formato de código no válido');
  if (!deviceUuid) return fail(res, 400, 'MISSING_DEVICE', 'Falta el identificador del dispositivo');

  const ref = db.collection('licenses').doc(code);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { kind: 'error', status: 404, code: 'NOT_FOUND', message: 'Licencia no encontrada' };
      }

      const lic = snap.data() || {};

      const status = String(lic.status || '').toLowerCase();
      if (status === 'revoked' || status === 'refunded') {
        return { kind: 'error', status: 403, code: 'BLOCKED', message: 'Licencia no válida. Contacta con soporte.' };
      }

      if (isExpired(lic.expiresAt)) {
        // Bloqueo total al caducar
        tx.update(ref, { status: 'expired', updatedAt: nowDate() });
        return { kind: 'error', status: 403, code: 'EXPIRED', message: 'Licencia caducada. Renueva para continuar.' };
      }

      const currentDevice = lic.deviceUuid ? String(lic.deviceUuid) : null;

      // Caso 1: nunca activada -> asigna el dispositivo
      if (!currentDevice) {
        tx.update(ref, {
          deviceUuid,
          activatedAt: nowDate(),
          updatedAt: nowDate(),
        });

        return {
          kind: 'ok',
          code,
          expiresAt: lic.expiresAt,
          deviceUuid,
          firstActivation: true,
        };
      }

      // Caso 2: ya activada en este mismo dispositivo -> ok
      if (currentDevice === deviceUuid) {
        return {
          kind: 'ok',
          code,
          expiresAt: lic.expiresAt,
          deviceUuid,
          firstActivation: false,
        };
      }

      // Caso 3: activada en otro dispositivo -> bloqueo (cambio anual es manual por soporte)
      return {
        kind: 'error',
        status: 403,
        code: 'DEVICE_MISMATCH',
        message:
          'Esta licencia ya está activada en otro dispositivo. Para cambiar de equipo (1 vez al año), contacta con soporte: contacto@tuappgo.com',
      };
    });

    if (result.kind === 'ok') {
      // Normaliza expiresAt a ISO para el cliente
      const expiresAt = result.expiresAt?.toDate ? result.expiresAt.toDate() : new Date(result.expiresAt);
      return ok(res, {
        license: {
          code: result.code,
          deviceUuid: result.deviceUuid,
          expiresAt: expiresAt.toISOString(),
          firstActivation: result.firstActivation,
        },
      });
    }

    return fail(res, result.status, result.code, result.message);
  } catch (err) {
    // Mejor esfuerzo: registrar error en doc (sin romper)
    try {
      await ref.set({ lastError: String(err.message || err), updatedAt: nowDate() }, { merge: true });
    } catch (_) {}

    return fail(res, 500, 'SERVER_ERROR', 'Error interno al activar la licencia');
  }
}

module.exports = { activateLicenseHandler };
