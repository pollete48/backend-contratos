// license-recover.js
// Endpoint: recuperar licencia por email (solo 1 vez)
// - Busca licencia activa no caducada por email
// - Si recoveryUsed=false -> envía email con el código y marca recoveryUsed=true
// - Si ya se usó -> bloquea y deriva a soporte
//
// Requisitos:
// - Firestore en req.app.locals.db
// - Nodemailer (SMTP_* env) y SMTP_FROM
// - SUPPORT_EMAIL=contacto@tuappgo.com
//
// Ruta sugerida en Express:
//   app.use(express.json());
//   app.post('/api/licencia/recuperar', recoverLicenseHandler);

const nodemailer = require('nodemailer');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

function buildTransporter() {
  return nodemailer.createTransport({
    host: requireEnv('SMTP_HOST'),
    port: Number(requireEnv('SMTP_PORT')),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: requireEnv('SMTP_USER'),
      pass: requireEnv('SMTP_PASS'),
    },
  });
}

function nowDate() {
  return new Date();
}

function formatDateES(date) {
  const d = new Date(date);
  return d.toLocaleDateString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit' });
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

function buildRecoveryEmail({ code, expiresAt, supportEmail }) {
  const expires = formatDateES(expiresAt);
  return {
    subject: 'Recuperación de tu licencia de TuAppGo',
    text:
`Aquí tienes tu código de licencia:

${code}

Válida hasta: ${expires}

Si necesitas un nuevo reenvío, contacta con soporte: ${supportEmail}
`,
    html:
`<p>Aquí tienes tu código de licencia:</p>
<p><strong style="font-size:18px;letter-spacing:1px;">${code}</strong></p>
<p><strong>Válida hasta:</strong> ${expires}</p>
<p>Si necesitas un nuevo reenvío, contacta con soporte: ${supportEmail}</p>`,
  };
}

/**
 * Body:
 *  { "email": "cliente@empresa.com" }
 */
async function recoverLicenseHandler(req, res) {
  const db = req.app?.locals?.db;
  if (!db) return fail(res, 500, 'SERVER_CONFIG', 'Firestore db no configurado');

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return fail(res, 400, 'MISSING_EMAIL', 'Falta el email');

  const supportEmail = process.env.SUPPORT_EMAIL || 'contacto@tuappgo.com';

  try {
    // Busca licencias del email (limitamos a pocas para no escanear)
    // Preferimos activa y no caducada; si hay varias, elegimos la más reciente por paidAt si existe.
    const snap = await db
      .collection('licenses')
      .where('email', '==', email)
      .limit(20)
      .get();

    if (snap.empty) {
      // Por privacidad, no confirmamos si existe o no: devolvemos OK genérico.
      return ok(res, { message: 'Si existe una licencia activa para este email, recibirás un correo con el código.' });
    }

    // Filtra candidatas activas
    const candidates = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const status = String(d.status || '').toLowerCase();
      if (status !== 'active') return;
      if (isExpired(d.expiresAt)) return;
      candidates.push({ ref: doc.ref, data: d });
    });

    if (candidates.length === 0) {
      return ok(res, { message: 'Si existe una licencia activa para este email, recibirás un correo con el código.' });
    }

    // Elige la más reciente por paidAt o createdAt
    candidates.sort((a, b) => {
      const ap = a.data.paidAt?.toDate ? a.data.paidAt.toDate() : (a.data.paidAt ? new Date(a.data.paidAt) : null);
      const bp = b.data.paidAt?.toDate ? b.data.paidAt.toDate() : (b.data.paidAt ? new Date(b.data.paidAt) : null);
      const ac = a.data.createdAt?.toDate ? a.data.createdAt.toDate() : (a.data.createdAt ? new Date(a.data.createdAt) : new Date(0));
      const bc = b.data.createdAt?.toDate ? b.data.createdAt.toDate() : (b.data.createdAt ? new Date(b.data.createdAt) : new Date(0));
      const at = (ap || ac).getTime();
      const bt = (bp || bc).getTime();
      return bt - at;
    });

    const chosen = candidates[0];
    const code = String(chosen.data.code || chosen.ref.id);

    // Bloqueo por 1 uso
    const recoveryUsed = !!chosen.data.recoveryUsed;
    if (recoveryUsed) {
      return fail(
        res,
        403,
        'RECOVERY_ALREADY_USED',
        `La recuperación automática ya se ha utilizado. Contacta con soporte: ${supportEmail}`
      );
    }

    // Marcamos recoveryUsed dentro de transacción (evita doble envío si el usuario spammea)
    const expiresAt = chosen.data.expiresAt?.toDate ? chosen.data.expiresAt.toDate() : new Date(chosen.data.expiresAt);

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(chosen.ref);
      if (!fresh.exists) throw new Error('Licencia ya no existe');
      const d = fresh.data() || {};
      if (String(d.status || '').toLowerCase() !== 'active') throw new Error('Licencia no activa');
      if (isExpired(d.expiresAt)) throw new Error('Licencia caducada');
      if (d.recoveryUsed) {
        throw new Error('RECOVERY_ALREADY_USED');
      }
      tx.update(chosen.ref, { recoveryUsed: true, recoveryUsedAt: nowDate(), updatedAt: nowDate() });
    });

    // Envía email con el código
    const transporter = buildTransporter();
    const mail = buildRecoveryEmail({ code, expiresAt, supportEmail });

    await transporter.sendMail({
      from: requireEnv('SMTP_FROM'),
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });

    return ok(res, { message: 'Si existe una licencia activa para este email, recibirás un correo con el código.' });
  } catch (err) {
    // Si la transacción devolvió RECOVERY_ALREADY_USED
    if (String(err.message || '').includes('RECOVERY_ALREADY_USED')) {
      return fail(
        res,
        403,
        'RECOVERY_ALREADY_USED',
        `La recuperación automática ya se ha utilizado. Contacta con soporte: ${supportEmail}`
      );
    }

    return fail(res, 500, 'SERVER_ERROR', 'Error interno al recuperar la licencia');
  }
}

module.exports = { recoverLicenseHandler };
