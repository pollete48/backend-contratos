// server.js
require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');

// IMPORTACIONES DE HANDLERS
const { stripeWebhookHandler } = require('./stripe-webhook');
const { activateLicenseHandler } = require('./license-activate');
const { recoverLicenseHandler } = require('./license-recover');
const { supportChangeDeviceHandler } = require('./license-support');
const { createCheckoutSessionHandler } = require('./stripe-checkout');

// IMPORTACIONES PARA PAGOS MANUALES Y ADMIN PANEL
const manualPayment = require('./manual-payment');
const adminPanel = require('./admin-panel');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Falta FIREBASE_SERVICE_ACCOUNT_JSON o GOOGLE_APPLICATION_CREDENTIALS');
  }
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

function main() {
  initFirebaseAdmin();

  const app = express();
  const port = Number(process.env.PORT || 3000);
  app.locals.db = admin.firestore();

  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    stripeWebhookHandler
  );

  app.use(express.json({ limit: '1mb' }));

  app.post('/api/stripe/checkout', createCheckoutSessionHandler);
  app.post('/api/licencia/activar', activateLicenseHandler);
  app.post('/api/licencia/recuperar', recoverLicenseHandler);
  app.post('/api/manual-order', manualPayment.createManualOrderHandler);

  // --- PANEL DE ADMINISTRACIÓN UNIFICADO ---
  
  // 1. Acceso visual
  app.get('/admin', adminPanel.adminPageHandler);

  // 2. SUPER-RUTA ÚNICA: Dashboard (Carga todo de golpe)
  app.get('/api/admin/dashboard', adminPanel.requireAdmin, adminPanel.getDashboardData);

  // 3. Acción de completar (Se mantiene individual por ser POST)
  app.post('/api/admin/manual-orders/:id/complete', adminPanel.requireAdmin, adminPanel.completeManualOrder);

  app.post('/api/admin/licencia/cambiar-dispositivo', supportChangeDeviceHandler);

  // --- MANEJO DE ERRORES ---
  app.use((_req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada' });
  });

  app.use((err, _req, res, _next) => {
    console.error('❌ Error detectado:', err);
    res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Error interno' });
  });

  requireEnv('STRIPE_SECRET_KEY');
  requireEnv('STRIPE_WEBHOOK_SECRET');
  requireEnv('SMTP_HOST');
  requireEnv('SMTP_PORT');
  requireEnv('SMTP_USER');
  requireEnv('SMTP_PASS');
  requireEnv('SMTP_FROM');
  requireEnv('ADMIN_KEY');
  requireEnv('PRECIO_BASE');

  app.listen(port, () => {
    console.log(`🚀 Backend unificado en puerto ${port}`);
  });
}

main();
