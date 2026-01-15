// server.js
// Servidor Express mínimo para:
// - Webhook Stripe (RAW body)
// - APIs JSON (activar, recuperar, soporte)
// - Firestore (firebase-admin) inyectado en app.locals.db
//
// Requisitos:
//   npm i express firebase-admin dotenv stripe nodemailer
//
// Arranque:
//   node server.js
//
// ENV obligatorias: ver .env.example (abajo)

require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');

const { stripeWebhookHandler } = require('./stripe-webhook');
const { activateLicenseHandler } = require('./license-activate');
const { recoverLicenseHandler } = require('./license-recover');
const { supportChangeDeviceHandler } = require('./license-support');
const { createCheckoutSessionHandler } = require('./stripe-checkout');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

/**
 * Inicializa firebase-admin.
 * Opción A (recomendada): GOOGLE_APPLICATION_CREDENTIALS apunta al JSON de service account.
 * Opción B: FIREBASE_SERVICE_ACCOUNT_JSON con el JSON completo (string).
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

  // Si no hay JSON inline, asumimos GOOGLE_APPLICATION_CREDENTIALS configurado
  // (firebase-admin lo toma del entorno en muchos setups, pero aquí lo forzamos si falta)
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'Falta FIREBASE_SERVICE_ACCOUNT_JSON o GOOGLE_APPLICATION_CREDENTIALS (ruta al serviceAccount.json)'
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

  // Inyecta Firestore en app.locals
  app.locals.db = admin.firestore();

  // Health
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

  // IMPORTANTÍSIMO:
  // 1) Webhook Stripe con RAW body y ANTES de express.json()
  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    stripeWebhookHandler
  );

  // 2) Resto: JSON normal
  app.use(express.json({ limit: '1mb' }));
  
  app.post('/api/stripe/checkout', createCheckoutSessionHandler);

  // Licencias
  app.post('/api/licencia/activar', activateLicenseHandler);
  app.post('/api/licencia/recuperar', recoverLicenseHandler);

  // Admin soporte (token en X-Admin-Token)
  app.post('/api/admin/licencia/cambiar-dispositivo', supportChangeDeviceHandler);

  // 404
  app.use((_req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada' }));

  // Error handler
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Error interno del servidor' });
  });

  // Validación mínima de entorno (solo lo que rompe en runtime)
  // Stripe + SMTP se usan en webhook/recuperación; si no vas a usar aún, puedes comentar estas líneas.
  requireEnv('STRIPE_SECRET_KEY');
  requireEnv('STRIPE_WEBHOOK_SECRET');
  requireEnv('SMTP_HOST');
  requireEnv('SMTP_PORT');
  requireEnv('SMTP_USER');
  requireEnv('SMTP_PASS');
  requireEnv('SMTP_FROM');
  requireEnv('ADMIN_TOKEN');

  app.listen(port, () => {
    console.log(`Backend escuchando en puerto ${port}`);
  });
}

main();
