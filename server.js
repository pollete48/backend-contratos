// server.js
require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const multer = require('multer');
const cors = require('cors');
const mammoth = require('mammoth');
const htmlPdf = require('html-pdf-node');
const path = require('path');
const fs = require('fs');

// IMPORTACIONES DE HANDLERS
const { stripeWebhookHandler } = require('./stripe-webhook');
const { activateLicenseHandler } = require('./license-activate');
const { recoverLicenseHandler } = require('./license-recover');
const { supportChangeDeviceHandler } = require('./license-support');
const { createCheckoutSessionHandler } = require('./stripe-checkout');
const { adminChangeDeviceHandler } = require('./license-admin-change-device');

// IMPORTACIONES PARA PAGOS MANUALES Y ADMIN PANEL
const manualPayment = require('./manual-payment');
const adminPanel = require('./admin-panel');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// --- UTILIDADES DE LICENCIA (Recuperadas de index.js) ---
function normalizarCodigo(codigo) {
  return String(codigo || '').trim().toUpperCase().replace(/\s+/g, '');
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
  if (ts && typeof ts.toDate === 'function') return ts.toDate();
  return null;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

// --- CONFIGURACIÓN CORS (Crucial para eliminar net::ERR_FAILED) ---
const allowedOrigins = [
  'https://tuappgo.com',
  'https://www.tuappgo.com',
  'http://localhost:8100',
  'http://localhost:4200',
  'https://backend-contratos-r9zb.onrender.com',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const o = String(origin).trim().replace(/\/+$/, '');
    if (allowedOrigins.includes(o) || o.endsWith('.onrender.com')) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS: ' + o));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
}));

app.options('*', cors());

// --- INICIALIZACIÓN FIREBASE ---
function initFirebaseAdmin() {
  if (admin.apps.length) return;
  
  // Intento 1: Variable de entorno JSON (la que acabamos de configurar)
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const serviceAccount = JSON.parse(json);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log('✅ Firebase inicializado via JSON Variable');
      return;
    } catch (e) {
      console.error('❌ Error parseando FIREBASE_SERVICE_ACCOUNT_JSON');
    }
  }

  // Intento 2: Ruta de archivo (compatible con tu configuración antigua)
  const saPathRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saPathRaw) {
    const saPath = path.isAbsolute(saPathRaw) ? saPathRaw : path.join(process.cwd(), saPathRaw);
    if (fs.existsSync(saPath)) {
      const serviceAccount = require(saPath);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log('✅ Firebase inicializado via Secret File');
      return;
    }
  }

  throw new Error('Falta configuración de Firebase (JSON o Archivo)');
}

function main() {
  initFirebaseAdmin();
  const db = admin.firestore();
  app.locals.db = db;

  // --- WEBHOOK STRIPE (Debe ir antes de express.json) ---
  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    stripeWebhookHandler
  );

  app.use(express.json({ limit: '10mb' }));

  // --- RUTAS DE SALUD ---
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
  
  app.get('/api/health/firestore', async (req, res) => {
    try {
      await db.collection('_health').doc('ping').get();
      return res.json({ ok: true });
    } catch (err) {
      return res.status(503).json({ ok: false, error: 'Firestore error' });
    }
  });

  // --- RUTAS DE PAGO (Sincronizadas con la App) ---
  app.post('/api/stripe/checkout', createCheckoutSessionHandler);
  
  // Aceptamos ambos nombres de ruta para no romper la App
  app.post('/api/pago/manual/crear', manualPayment.createManualOrderHandler);
  app.post('/api/manual-order', manualPayment.createManualOrderHandler);

  app.get('/api/precio', (req, res) => {
    const p = Number(process.env.PRICE_EUR || 0);
    res.json({ ok: true, priceEur: Number.isFinite(p) ? p : 0, currency: 'EUR' });
  });

  // --- RUTAS DE LICENCIA (Lógica recuperada de index.js) ---
  app.post('/api/licencia/activar', activateLicenseHandler);
  app.post('/api/licencia/recuperar', recoverLicenseHandler);
  
  // Validación online desde la App (Copiado íntegro de index.js)
  app.post('/api/licencia/validar', async (req, res) => {
    try {
      const codigo = normalizarCodigo(req.body?.codigo);
      const uuid = String(req.body?.uuid || '').trim();
      if (!codigo || !uuid) return res.status(400).json({ ok: false, reason: 'missing_fields' });
      if (!codigoFormatoValido(codigo)) return res.status(400).json({ ok: false, reason: 'invalid_format' });

      const licRef = db.collection('licenses').doc(codigo);
      const actRef = db.collection('activations').doc();

      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(licRef);
        if (!snap.exists) {
          tx.set(actRef, { code: codigo, uuid, createdAt: admin.firestore.FieldValue.serverTimestamp(), result: 'invalid' });
          return { ok: false, reason: 'not_found' };
        }
        const lic = snap.data();
        const status = lic.status || 'active';
        const activatedUuid = lic.activatedUuid || null;

        if (status === 'revoked') return { ok: false, reason: 'revoked' };

        const now = new Date();
        const expiresAtDate = timestampToDate(lic.expiresAt);
        if (expiresAtDate && now > expiresAtDate) return { ok: false, reason: 'expired' };

        if (status === 'active') {
          const expiresAt = admin.firestore.Timestamp.fromDate(addYears(now, 1));
          tx.update(licRef, { status: 'used', activatedUuid: uuid, activatedAt: admin.firestore.Timestamp.now(), expiresAt });
          return { ok: true };
        }

        if (activatedUuid === uuid) return { ok: true };
        return { ok: false, reason: 'used_by_other' };
      });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, reason: 'server_error' });
    }
  });

  app.post('/api/licencia/info', async (req, res) => {
    try {
      const codigo = normalizarCodigo(req.body?.codigo);
      const licRef = db.collection('licenses').doc(codigo);
      const snap = await licRef.get();
      if (!snap.exists) return res.json({ ok: false, reason: 'not_found' });
      const lic = snap.data();
      const expiresAtTs = lic.expiresAt || null;
      const expiresAt = expiresAtTs && typeof expiresAtTs.toDate === 'function' ? expiresAtTs.toDate() : null;
      return res.json({ ok: true, expiresAt: expiresAt ? expiresAt.toISOString() : null });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: 'server_error' });
    }
  });

  // --- GENERACIÓN DE PDF (Recuperado de index.js) ---
  app.post('/generar-pdf', upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).send('Archivo no recibido');
      const result = await mammoth.convertToHtml({ buffer: file.buffer });
      const fullHtml = `<html><head><meta charset="utf-8"><style>body{font-family:Arial;}</style></head><body>${result.value}</body></html>`;
      const pdfBuffer = await htmlPdf.generatePdf({ content: fullHtml }, { format: 'A4' });
      res.setHeader('Content-Disposition', 'attachment; filename=contrato.pdf');
      res.setHeader('Content-Type', 'application/pdf');
      res.send(pdfBuffer);
    } catch (err) {
      res.status(500).send('Error generando el PDF');
    }
  });

  // --- PANEL DE ADMINISTRACIÓN ---
  app.get('/admin', adminPanel.adminPageHandler);
  app.get('/api/admin/manual-orders', adminPanel.requireAdmin, adminPanel.listManualOrders);
  app.post('/api/admin/manual-orders/:id/complete', adminPanel.requireAdmin, adminPanel.completeManualOrder);
  app.get('/api/admin/invoices', adminPanel.requireAdmin, adminPanel.listInvoices);
  app.post('/api/admin/licencia/cambiar-dispositivo', supportChangeDeviceHandler);
  app.post('/api/admin/licencia/admin-cambio', adminPanel.requireAdmin, adminChangeDeviceHandler);

  // MANEJO DE 404
  app.use((_req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada' });
  });

  // MANEJO DE ERRORES GLOBALES
  app.use((err, _req, res, _next) => {
    console.error('❌ Error:', err);
    res.status(500).json({ ok: false, code: 'SERVER_ERROR' });
  });

  // VALIDACIÓN DE VARIABLES CRÍTICAS
  requireEnv('STRIPE_SECRET_KEY');
  requireEnv('ADMIN_KEY');

  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`🚀 Servidor Unificado Online en puerto ${port}`);
  });
}

main();
