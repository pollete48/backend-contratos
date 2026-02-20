// stripe-webhook.js
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const htmlPdf = require('html-pdf-node');
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

/**
 * Lógica de Contador de Factura con reseteo anual
 */
async function getNextInvoiceNumber(db) {
  const yearNow = new Date().getFullYear();
  const counterRef = db.collection('metadata').doc('invoice_counter');

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    let nextNum = 1;
    let lastYear = yearNow;

    if (snap.exists) {
      const data = snap.data();
      lastYear = data.year || yearNow;
      if (lastYear === yearNow) {
        nextNum = (data.current || 0) + 1;
      }
    }

    tx.set(counterRef, { current: nextNum, year: yearNow });
    return `${nextNum}/${yearNow}`;
  });
}

function formatDateES(date) {
  const d = date?.toDate
    ? date.toDate()
    : (date instanceof Date ? date : new Date(date));

  if (Number.isNaN(d.getTime())) return '—';

  return d.toLocaleDateString('es-ES', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * Genera el cuerpo del email y el diseño de la factura
 */
function buildInvoiceTemplate(invoiceData, code, supportEmail) {
  const emisor = {
    nombre: process.env.EMPRESA_NOMBRE || '',
    dni: process.env.EMPRESA_DNI || '',
    dir: process.env.EMPRESA_DIRECCION || '',
    tel: process.env.EMPRESA_TELEFONO || '',
    email: process.env.EMPRESA_EMAIL || ''
  };

  const facturaHtml = `
    <div style="margin-top:30px; border:1px solid #ddd; padding:20px; font-family:Arial, sans-serif; border-radius:8px; color:#333; max-width: 600px;">
      <table style="width:100%;">
        <tr>
          <td style="vertical-align:top;">
            <img src="https://tuappgo.com/contratos/assets/logo-tuappgo.png" alt="TuAppGo" style="height:105px;">
          </td>
          <td style="text-align:right; font-size:12px; color:#555;">
            <strong>EMISOR:</strong><br>
            ${emisor.nombre}<br>
            ${emisor.dni}<br>
            ${emisor.dir}<br>
            ${emisor.tel}
          </td>
        </tr>
      </table>
      
      <div style="margin-top:20px;">
        <h3 style="margin-bottom:5px; color:#1a1a1a;">FACTURA: ${invoiceData.numero}</h3>
        <p style="font-size:13px; margin-top:0;">Fecha: ${invoiceData.fecha}</p>
      </div>

      <table style="width:100%; border-collapse:collapse; margin-top:15px; font-size:15px;">
        <tr>
          <td style="padding:12px 10px; border-bottom:1px solid #eee;">Base Imponible</td>
          <td style="padding:12px 10px; border-bottom:1px solid #eee; text-align:right;">${invoiceData.base}€</td>
        </tr>
        <tr>
          <td style="padding:12px 10px; border-bottom:1px solid #eee;">IVA (${invoiceData.ivaPerc}%)</td>
          <td style="padding:12px 10px; border-bottom:1px solid #eee; text-align:right;">${invoiceData.iva}€</td>
        </tr>
        <tr>
          <td style="padding:12px 10px; border-bottom:1px solid #eee;">Retención IRPF (-${invoiceData.retPerc}%)</td>
          <td style="padding:12px 10px; border-bottom:1px solid #eee; text-align:right; color:#d9534f;">-${invoiceData.ret}€</td>
        </tr>
        <tr style="font-weight:bold; background:#f9f9f9; font-size:1.2em;">
          <td style="padding:15px 10px;">TOTAL PAGADO</td>
          <td style="padding:15px 10px; text-align:right; color:#28a745;">${invoiceData.total}€</td>
        </tr>
      </table>
    </div>
  `;

  const footerHtml = `
    <div style="margin-top:20px; font-family:Arial, sans-serif; font-size:13px; color:#555;">
      <hr style="border:none; border-top:1px solid #eee; margin-bottom:15px;" />
      <strong>TuAppGo</strong><br />
      Automatización de contratos y documentos<br />
      <a href="https://tuappgo.com" style="color:#2a6edb; text-decoration:none;">https://tuappgo.com</a>
    </div>
  `;

  return {
    html: `
      <div style="font-family:Arial, sans-serif; color:#333;">
        <p>Tuappgo te agradece tu confianza por tu compra.</p>
        <p><strong>Tu código de licencia:</strong><br>
        <span style="font-size:18px;letter-spacing:1px; color:#2a6edb;">${code}</span></p>
        <p><strong>Válida hasta:</strong> ${invoiceData.fecha}</p>
        <p><strong>Cómo activar:</strong> Abre la app, ve a Ajustes → Licencia, pega el código y activa.</p>
        <p>Adjuntamos a este email su factura detallada en formato PDF.</p>
        ${facturaHtml}
        <p style="margin-top:20px; font-size:12px; color:#777;">Soporte: ${supportEmail}</p>
        ${footerHtml}
      </div>
    `,
    facturaSoloHtml: `<html><body>${facturaHtml}</body></html>`
  };
}

async function stripeWebhookHandler(req, res) {
  let event;

  try {
    const webhookSecret = requireEnv('STRIPE_WEBHOOK_SECRET');
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error('[webhook] Signature error:', err.message);
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  const db = req.app?.locals?.db;
  if (!db) return res.status(500).send('Firestore db no configurado');

  const eventsCol = db.collection('stripe_events');
  const eventRef = eventsCol.doc(event.id);

  // Idempotencia: evitar procesar dos veces el mismo evento
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

  // Solo nos interesa checkout.session.completed
  if (event.type !== 'checkout.session.completed') {
    await eventRef.set({ status: 'ignored', processedAt: new Date() }, { merge: true });
    return res.json({ received: true });
  }

  const session = event.data.object;
  if (session.payment_status !== 'paid') {
    await eventRef.set({ status: 'ignored', reason: 'not_paid', processedAt: new Date() }, { merge: true });
    return res.json({ received: true });
  }

  try {
    const customerEmail = (session.customer_details?.email || session.customer_email).toLowerCase();
    const stripeSessionId = session.id;
    const paymentIntentId = session.payment_intent || null;

    // Verificar si ya existe licencia para esta sesión
    const existing = await db.collection('licenses').where('stripe.sessionId', '==', stripeSessionId).limit(1).get();
    if (!existing.empty) {
      await eventRef.set({ status: 'processed', note: 'License already exists' }, { merge: true });
      return res.json({ received: true });
    }

    const paidAt = new Date(session.created * 1000);

    // 1. Generar Licencia
    const { code, expiresAt } = await createLicenseFromStripe(db, {
      email: customerEmail,
      stripeSessionId,
      paymentIntentId,
      paidAt,
      amountTotal: session.amount_total,
      currency: session.currency,
      collectionName: 'licenses',
    });

    // 2. Lógica de Factura
    const numFactura = await getNextInvoiceNumber(db);
    const ivaPerc = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retPerc = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    
    const totalRaw = (session.amount_total / 100).toFixed(2);
    const baseVal = "130.00";
    const ivaVal = (130 * (ivaPerc / 100)).toFixed(2);
    const retVal = (130 * (retPerc / 100)).toFixed(2);

    const invoiceData = {
      numero: numFactura,
      fecha: new Date().toLocaleDateString('es-ES'),
      base: baseVal.replace('.', ','),
      iva: ivaVal.replace('.', ','),
      ret: retVal.replace('.', ','),
      total: totalRaw.replace('.', ','),
      ivaPerc,
      retPerc
    };

    const supportEmail = process.env.SUPPORT_EMAIL || 'contacto@tuappgo.com';
    const emailTemplates = buildInvoiceTemplate(invoiceData, code, supportEmail);

    // 3. Generar PDF Buffer
    const options = { format: 'A4' };
    const pdfBuffer = await htmlPdf.generatePdf({ content: emailTemplates.facturaSoloHtml }, options);

    // 4. Enviar Email con Adjunto
    const transporter = buildTransporter();
    await transporter.sendMail({
      from: requireEnv('SMTP_FROM'),
      to: customerEmail.trim(),
      subject: 'Tu licencia y factura de TuAppGo',
      html: emailTemplates.html,
      attachments: [
        {
          filename: `Factura_${numFactura.replace('/', '-')}.pdf`,
          content: pdfBuffer
        }
      ]
    });

    await eventRef.set({
      status: 'processed',
      processedAt: new Date(),
      licenseCode: code,
      invoiceNumber: numFactura,
      email: customerEmail
    }, { merge: true });

    return res.json({ received: true });

  } catch (err) {
    console.error('[webhook] Error procesando sesión:', err);
    try {
      await eventRef.set({ status: 'error', error: err.message, processedAt: new Date() }, { merge: true });
    } catch {}
    return res.status(500).send(err.message);
  }
}

module.exports = { stripeWebhookHandler };
