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

/**
 * Inicializa firebase-admin.
 */
function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    return;
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'Falta FIREBASE_SERVICE_ACCOUNT_JSON o GOOGLE_APPLICATION_CREDENTIALS'
    );
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

function main() {
  initFirebaseAdmin();

  const app = express();
  const port = Number(process.env.PORT || 3000);

  // Inyecta Firestore en app.locals.db
  app.locals.db = admin.firestore();

  // --- RUTAS PÚBLICAS Y WEBHOOKS ---
  
  // Health check
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

  // Webhook Stripe (Debe ir antes de express.json())
  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    stripeWebhookHandler
  );

  // Middleware para parsear JSON (Resto de rutas)
  app.use(express.json({ limit: '1mb' }));

  // --- APIS DE CLIENTE (APP) ---
  
  app.post('/api/stripe/checkout', createCheckoutSessionHandler);
  app.post('/api/licencia/activar', activateLicenseHandler);
  app.post('/api/licencia/recuperar', recoverLicenseHandler);
  
  // Solicitud de pago manual (Bizum/Transferencia)
  app.post('/api/manual-order', manualPayment.createManualOrderHandler);

  // --- PANEL DE ADMINISTRACIÓN (ADMIN) ---
  
  // 1. Acceso visual al panel
  app.get('/admin', adminPanel.adminPageHandler);

  // 2. APIs de gestión de pedidos
  app.get('/api/admin/manual-orders', adminPanel.requireAdmin, adminPanel.listManualOrders);
  app.post('/api/admin/manual-orders/:id/complete', adminPanel.requireAdmin, adminPanel.completeManualOrder);

  // 3. API Libro de Facturas (La que daba error 404)
  app.get('/api/admin/invoices', adminPanel.requireAdmin, adminPanel.listInvoices);

  // 4. Soporte técnico
  app.post('/api/admin/licencia/cambiar-dispositivo', supportChangeDeviceHandler);

  // --- MANEJO DE ERRORES Y FINALIZACIÓN ---

  // El "Muro" 404: Solo se ejecuta si ninguna ruta de arriba coincide
  app.use((_req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada' });
  });

  // Manejador global de errores (500)
  app.use((err, _req, res, _next) => {
    console.error('❌ Error detectado:', err);
    res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Error interno del servidor' });
  });

  // Validación de variables de entorno críticas
  requireEnv('STRIPE_SECRET_KEY');
  requireEnv('STRIPE_WEBHOOK_SECRET');
  requireEnv('SMTP_HOST');
  requireEnv('SMTP_PORT');
  requireEnv('SMTP_USER');
  requireEnv('SMTP_PASS');
  requireEnv('SMTP_FROM');
  requireEnv('ADMIN_KEY'); // Variable para acceso al panel
  requireEnv('PRECIO_BASE'); // Nueva variable de desglose

  app.listen(port, () => {
    console.log(`🚀 Backend de TuAppGo escuchando en puerto ${port}`);
  });
}

main();
