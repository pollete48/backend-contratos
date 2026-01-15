const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { createLicenseFromStripe } = require('./license-issue');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

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

function formatDateES(date) {
  return new Date(date).toLocaleDateString('es-ES', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function buildPurchaseEmail({ code, expiresAt, supportEmail }) {
  const expires = formatDateES(expiresAt);
  return {
    subject: 'Tu licencia de TuAppGo',
    text:
`Gracias por tu compra.

Tu código de licencia:
${code}

Válida hasta: ${expires}

Cómo activar:
1) Abre la app
2) Ajustes -> Licencia
3) Pega el código y activa

Importante:
- La licencia es para 1 dispositivo.
- Incluye 1 cambio de dispositivo al año (gestionado por soporte).

Soporte: ${supportEmail}
`,
    html:
`<p>Gracias por tu compra.</p>
<p><strong>Tu código de licencia:</strong><br>
<span style="font-size:18px;letter-spacing:1px;">${code}</span></p>
<p><strong>Válida hasta:</strong> ${expires}</p>
<p><strong>Cómo activar:</strong><br>
1) Abre la app<br>
2) Ajustes → Licencia<br>
3) Pega el código y activa</p>
<p><strong>Importante:</strong><br>
- La licencia es para 1 dispositivo.<br>
- Incluye 1 cambio de dispositivo al año (gestionado por soporte).</p>
<p><strong>Soporte:</strong> ${supportEmail}</p>`,
  };
}

async function stripeWebhookHandler(req, res) {
  let event;

  try {
    const webhookSecret = requireEnv('STRIPE_WEBHOOK_SECRET');
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  const db = req.app?.locals?.db;
  if (!db) return res.status(500).send('Firestore db no configurado');

  const eventsCol = db.collection('stripe_events');
  const eventRef = eventsCol.doc(event.id);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(eventRef);
      if (snap.exists) {
        tx.update(eventRef, { lastSeenAt: new Date() });
        return;
      }
      tx.create(eventRef, {
        type: event.type,
        createdAt: new Date(event.created * 1000),
        receivedAt: new Date(),
        status: 'received',
      });
    });
  } catch (e) {
    return res.status(500).send(`Idempotency error: ${e.message}`);
  }

  try {
    if (event.type !== 'checkout.session.completed') {
      await eventRef.set(
        { status: 'ignored', processedAt: new Date() },
        { merge: true }
      );
      return res.json({ received: true });
    }

    const session = event.data.object;
    if (session.payment_status !== 'paid') {
      await eventRef.set(
        { status: 'ignored', reason: 'not_paid', processedAt: new Date() },
        { merge: true }
      );
      return res.json({ received: true });
    }

    const customerEmail =
      session.customer_details?.email || session.customer_email;
    if (!customerEmail) throw new Error('Sesión Stripe sin email');

    const stripeSessionId = session.id;
    const paymentIntentId = session.payment_intent || null;

    const existing = await db
      .collection('licenses')
      .where('stripe.sessionId', '==', stripeSessionId)
      .limit(1)
      .get();

    if (!existing.empty) {
      await eventRef.set(
        { status: 'processed', note: 'License already exists' },
        { merge: true }
      );
      return res.json({ received: true });
    }

    const paidAt = new Date(session.created * 1000);

    const { code, expiresAt } = await createLicenseFromStripe(db, {
      email: customerEmail,
      stripeSessionId,
      paymentIntentId,
      paidAt,
      collectionName: 'licenses',
    });

    const transporter = buildTransporter();
    const supportEmail = process.env.SUPPORT_EMAIL || 'contacto@tuappgo.com';

    const mail = buildPurchaseEmail({
      code,
      expiresAt,
      supportEmail,
    });

    try {
  await transporter.sendMail({
    from: requireEnv('SMTP_FROM'),
    to: customerEmail.trim(),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
} catch (mailErr) {
  // El email NO debe romper el webhook
  await eventRef.set(
    {
      emailError: String(mailErr.message || mailErr),
      emailFailedAt: new Date(),
    },
    { merge: true }
  );
}

    await eventRef.set(
      {
        status: 'processed',
        processedAt: new Date(),
        licenseCode: code,
        email: customerEmail.toLowerCase(),
      },
      { merge: true }
    );

    return res.json({ received: true });
  } catch (err) {
    try {
      await eventRef.set(
        { status: 'error', error: err.message, processedAt: new Date() },
        { merge: true }
      );
    } catch {}
    return res.status(500).send(err.message);
  }
}

module.exports = { stripeWebhookHandler };
