require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const mammoth = require('mammoth');
const htmlPdf = require('html-pdf-node');
const { activateLicenseHandler } = require('./license-activate');
const { recoverLicenseHandler } = require('./license-recover');
const { adminChangeDeviceHandler } = require('./license-admin-change-device');
const { createCheckoutSessionHandler } = require('./stripe-checkout');
const { stripeWebhookHandler } = require('./stripe-webhook');

require('dotenv').config();

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Si no hay variable, usa una lista segura por defecto
const allowedOrigins = corsOrigins.length > 0 ? corsOrigins : [
  'https://tuappgo.com',
  'https://www.tuappgo.com',
  'http://localhost:8100',
  'http://localhost:4200',
];

app.use(cors({
  origin: (origin, cb) => {
    // Permitir llamadas sin Origin (Stripe/servidores/curl) y apps nativas
    if (!origin) return cb(null, true);
    return allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Preflight para cualquier ruta
app.options('*', cors());

// --- Firebase Admin (Firestore) ---
let db = null;

function initFirebase() {
  const saPathRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saPathRaw) {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT no definido. Firestore deshabilitado.');
    return;
  }

  const saPath = path.isAbsolute(saPathRaw) ? saPathRaw : path.join(process.cwd(), saPathRaw);

  if (!fs.existsSync(saPath)) {
    console.warn(`⚠️ Service Account no encontrado en: ${saPath}. Firestore deshabilitado.`);
    return;
  }

  const serviceAccount = require(saPath);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  db = admin.firestore();
  app.locals.db = db;
  console.log('✅ Firestore inicializado correctamente');
}

initFirebase();


// --- Stripe webhook (RAW body) ---
// IMPORTANTE: esto debe ir ANTES de app.use(express.json())
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);


// JSON para el API (OJO: para Stripe webhook más adelante se ajustará con raw-body)
app.use(express.json());

// --- Stripe: checkout ---
app.post('/api/stripe/checkout', createCheckoutSessionHandler);

// --- Licencias: activar y recuperar ---
app.post('/api/licencia/activar', activateLicenseHandler);
app.post('/api/licencia/recuperar', recoverLicenseHandler);
app.post('/api/admin/licencia/cambiar-dispositivo', adminChangeDeviceHandler);

// --- Utilidades licencia ---
function normalizarCodigo(codigo) {
  return String(codigo || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function codigoFormatoValido(codigo) {
  const re = /^CONTR(-[A-Z0-9]{4}){3,5}$/;
  return re.test(codigo);
}

function addYears(date, years) {
  const d = new Date(date.getTime());
  d.setFullYear(d.getFullYear() + years);
  return d;
}

function timestampToDate(ts) {
  // Firestore Timestamp has toDate()
  if (ts && typeof ts.toDate === 'function') return ts.toDate();
  return null;
}

// --- Healthcheck Firestore ---
app.get('/api/health/firestore', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Firestore no inicializado' });
    await db.collection('_health').doc('ping').get();
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Firestore healthcheck error:', err);
    return res.status(500).json({ ok: false, error: 'Firestore error' });
  }
});

// --- Licencias: validar código online ---
// Espera: { codigo, uuid }
// Responde: { ok: boolean, reason?: string }
app.post('/api/licencia/validar', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, reason: 'firestore_not_ready' });

    const codigo = normalizarCodigo(req.body?.codigo);
    const uuid = String(req.body?.uuid || '').trim();

    if (!codigo || !uuid) {
      return res.status(400).json({ ok: false, reason: 'missing_fields' });
    }

    if (!codigoFormatoValido(codigo)) {
      return res.status(400).json({ ok: false, reason: 'invalid_format' });
    }

    const licRef = db.collection('licenses').doc(codigo);
    const actRef = db.collection('activations').doc();

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(licRef);

      if (!snap.exists) {
        tx.set(actRef, {
          code: codigo,
          uuid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          result: 'invalid',
        });
        return { ok: false, reason: 'not_found' };
      }

      const lic = snap.data() || {};
      const status = lic.status || 'active';
      const activatedUuid = lic.activatedUuid || null;

      // Revocada
      if (status === 'revoked') {
        tx.set(actRef, {
          code: codigo,
          uuid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          result: 'revoked',
        });
        return { ok: false, reason: 'revoked' };
      }

      const now = new Date();
      const expiresAtTs = lic.expiresAt || null;
      const expiresAtDate = timestampToDate(expiresAtTs);

      // Si ya existe expiresAt y está caducada, bloquear (tanto para used como para active)
      if (expiresAtDate && now > expiresAtDate) {
        tx.set(actRef, {
          code: codigo,
          uuid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          result: 'expired',
        });
        return { ok: false, reason: 'expired' };
      }

      // Primera activación: pasa a used, fija activatedAt y expiresAt (1 año)
      if (status === 'active') {
        const activatedAt = admin.firestore.Timestamp.now();
        const expiresAt = admin.firestore.Timestamp.fromDate(addYears(now, 1));

        tx.update(licRef, {
          status: 'used',
          activatedUuid: uuid,
          activatedAt,
          expiresAt,
          // Nota: NO tocamos createdAt ni email; si existen se mantienen.
        });

        tx.set(actRef, {
          code: codigo,
          uuid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          result: 'ok_first_use',
        });

        return { ok: true };
      }

      // status === 'used'
      if (activatedUuid === uuid) {
        // Reinstalación / mismo equipo:
        // - si no existe expiresAt (licencias antiguas), lo calculamos y lo guardamos para normalizar.
        if (!expiresAtDate) {
          const base = timestampToDate(lic.activatedAt) || now;
          const newExpires = admin.firestore.Timestamp.fromDate(addYears(base, 1));

          tx.update(licRef, {
            expiresAt: newExpires,
          });
        }

        tx.set(actRef, {
          code: codigo,
          uuid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          result: 'ok_same_device',
        });
        return { ok: true };
      }

      // Usada en otro equipo
      tx.set(actRef, {
        code: codigo,
        uuid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        result: 'used_by_other',
      });
      return { ok: false, reason: 'used_by_other' };
    });

    // Mantener 200 para validaciones
    return res.json(result.ok ? { ok: true } : result);
  } catch (err) {
    console.error('❌ Error en /api/licencia/validar:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
});


// --- Licencias: info de licencia (para mostrar expiresAt real) ---
// Espera: { codigo, uuid }
// Responde: { ok: true, expiresAt: ISO } o { ok:false, reason }
app.post('/api/licencia/info', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, reason: 'firestore_not_ready' });

    const codigo = normalizarCodigo(req.body?.codigo);
    const uuid = String(req.body?.uuid || '').trim();

    if (!codigo || !uuid) return res.status(400).json({ ok: false, reason: 'missing_fields' });
    if (!codigoFormatoValido(codigo)) return res.status(400).json({ ok: false, reason: 'invalid_format' });

    const licRef = db.collection('licenses').doc(codigo);
    const snap = await licRef.get();

    if (!snap.exists) return res.json({ ok: false, reason: 'not_found' });

    const lic = snap.data() || {};
    if ((lic.status || 'active') === 'revoked') return res.json({ ok: false, reason: 'revoked' });

    // Solo devolvemos info si pertenece al mismo equipo (o todavía no usada)
    const activatedUuid = lic.activatedUuid || null;
    const status = lic.status || 'active';

    if (status === 'used' && activatedUuid && activatedUuid !== uuid) {
      return res.json({ ok: false, reason: 'used_by_other' });
    }

    // expiresAt debe existir en licencias anuales (si no existe, no rompemos UI)
    const expiresAtTs = lic.expiresAt || null;
    const expiresAt = expiresAtTs && typeof expiresAtTs.toDate === 'function' ? expiresAtTs.toDate() : null;

    if (!expiresAt) return res.json({ ok: true }); // ok pero sin fecha

    // Si ya caducó, devolvemos caducada
    if (new Date() > expiresAt) return res.json({ ok: false, reason: 'expired' });

    return res.json({ ok: true, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error('❌ Error en /api/licencia/info:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
});


// --- Endpoint existente: PDF ---
app.post('/generar-pdf', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).send('Archivo no recibido');

    const result = await mammoth.convertToHtml({ buffer: file.buffer });
    const htmlContent = result.value;

    const fullHtml = `
      <html>
        <head><meta charset="utf-8"><style>body { font-family: Arial; }</style></head>
        <body>${htmlContent}</body>
      </html>
    `;

    const options = { format: 'A4' };
    const fileToCreate = { content: fullHtml };

    const pdfBuffer = await htmlPdf.generatePdf(fileToCreate, options);

    res.setHeader('Content-Disposition', 'attachment; filename=contrato.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('❌ Error al generar PDF:', err);
    res.status(500).send('Error generando el PDF');
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ Backend activo en http://localhost:${PORT}`);
  console.log(`   - PDF: POST http://localhost:${PORT}/generar-pdf`);
  console.log(`   - Health Firestore: GET http://localhost:${PORT}/api/health/firestore`);
  console.log(`   - Licencia validar: POST http://localhost:${PORT}/api/licencia/validar`);
});

