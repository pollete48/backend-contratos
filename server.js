// server.js
require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');

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

  // Health
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

  // 1) Webhook Stripe (RAW body)
  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    stripeWebhookHandler
  );

  // 2) Resto: JSON normal
  app.use(express.json({ limit: '1mb' }));
  
  app.post('/api/stripe/checkout', createCheckoutSessionHandler);

  // Licencias (App)
  app.post('/api/licencia/activar', activateLicenseHandler);
  app.post('/api/licencia/recuperar', recoverLicenseHandler);

  // Pagos Manuales (App)
  app.post('/api/manual-order', manualPayment.createManualOrderHandler);

  // --- PANEL DE ADMINISTRACIÓN ---
  // Vista HTML del Panel
  app.get('/admin', adminPanel.adminPageHandler);

  // APIs del Panel (Protegidas con requireAdmin)
  app.get('/api/admin/manual-orders', adminPanel.requireAdmin, adminPanel.listManualOrders);
  app.post('/api/admin/manual-orders/:id/complete', adminPanel.requireAdmin, adminPanel.completeManualOrder);
  
  // NUEVA RUTA: Libro de Facturas
  app.get('/api/admin/invoices', adminPanel.requireAdmin, adminPanel.listInvoices);

  // Soporte antiguo
  app.post('/api/admin/licencia/cambiar-dispositivo', supportChangeDeviceHandler);

  // 404
  app.use((_req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada' }));

  // Error handler
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Error interno del servidor' });
  });

  // Validación de entorno
  requireEnv('STRIPE_SECRET_KEY');
  requireEnv('STRIPE_WEBHOOK_SECRET');
  requireEnv('SMTP_HOST');
  requireEnv('SMTP_PORT');
  requireEnv('SMTP_USER');
  requireEnv('SMTP_PASS');
  requireEnv('SMTP_FROM');
  requireEnv('ADMIN_KEY'); // Usamos ADMIN_KEY para el panel

  app.listen(port, () => {
    console.log(`Backend escuchando en puerto ${port}`);
  });
}

main();
