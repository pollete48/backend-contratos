// stripe-webhook.js
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

function buildPurchaseEmail({ code, expiresAt, supportEmail, invoiceData }) {
  const expires = invoiceData.fecha; // Usamos la misma fecha de la factura
  
  // Datos del emisor desde ENV
  const emisor = {
    nombre: process.env.EMPRESA_NOMBRE || '',
    dni: process.env.EMPRESA_DNI || '',
    dir: process.env.EMPRESA_DIRECCION || '',
    tel: process.env.EMPRESA_TELEFONO || '',
    email: process.env.EMPRESA_EMAIL || ''
  };

  const facturaHtml = `
    <div style="margin-top:30px; border:1px solid #ddd; padding:20px; font-family:Arial, sans-serif; border-radius:8px;">
      <table style="width:100%;">
        <tr>
          <td style="vertical-align:top;">
            <img src="https://tuappgo.com/contratos/assets/logo-tuappgo.png" alt="TuAppGo" style="height:60px;">
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
        <h3 style="margin-bottom:5px;">FACTURA: ${invoiceData.numero}</h3>
        <p style="font-size:13px; margin-top:0;">Fecha: ${invoiceData.fecha}</p>
      </div>

      <table style="width:100%; border-collapse:collapse; margin-top:15px; font-size:14px;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:8px; text-align:left; border-bottom:1px solid #ddd;">Descripción</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid #ddd;">Base</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid #ddd;">IVA (${invoiceData.ivaPerc}%)</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid #ddd;">IRPF (-${invoiceData.retPerc}%)</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid #ddd;">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:8px; border-bottom:1px solid #eee;">Licencia Anual TuAppGo</td>
            <td style="padding:8px; text-align:right; border-bottom:1px solid #eee;">${invoiceData.base}€</td>
            <td style="padding:8px; text-align:right; border-bottom:1px solid #eee;">${invoiceData.iva}€</td>
            <td style="padding:8px; text-align:right; border-bottom:1px solid #eee; color:#d9534f;">-${invoiceData.ret}€</td>
            <td style="padding:8px; text-align:right; border-bottom:1px solid #eee; font-weight:bold;">${invoiceData.total}€</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;

  return {
    subject: 'Tu licencia y factura de TuAppGo',
    text: `Tuappgo te agradece tu confianza.\n\nCódigo de licencia: ${code}\nVálida hasta: ${expires}\n\nFactura: ${invoiceData.numero}\nTotal: ${invoiceData.total}€`,
    html: `
      <p>Tuappgo te agradece tu confianza por tu compra.</p>
      <p><strong>Tu código de licencia:</strong><br>
      <span style="font-size:18px;letter-spacing:1px; color:#2a6edb;">${code}</span></p>
      <p><strong>Válida hasta:</strong> ${expires}</p>
      <p><strong>Cómo activar:</strong> Abre la app, ve a Ajustes → Licencia, pega el código y activa.</p>
      <hr style="margin:20px 0; border:none; border-top:1px solid #eee;">
      ${facturaHtml}
      <p style="margin-top:20px; font-size:12px; color:#777;">Soporte: ${supportEmail}</p>
    `,
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

  const eventRef = db.collection('stripe_events').doc(event.id);

  // Manejo de eventos
  if (event.type !== 'checkout.session.completed') return res.json({ received: true });

  const session = event.data.object;
  if (session.payment_status !== 'paid') return res.json({ received: true });

  const customerEmail = session.customer_details?.email || session.customer_email;
  const stripeSessionId = session.id;

  try {
    // 1. Generar licencia
    const paidAt = new Date();
    const { code, expiresAt } = await createLicenseFromStripe(db, {
      email: customerEmail,
      stripeSessionId,
      paidAt,
      amountTotal: session.amount_total,
      currency: session.currency,
      collectionName: 'licenses',
    });

    // 2. Obtener número de factura y datos dinámicos
    const numFactura = await getNextInvoiceNumber(db);
    const ivaPerc = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retPerc = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    
    // Cálculos basados en el total de 148.20
    const total = (session.amount_total / 100).toFixed(2);
    const base = "130.00";
    const iva = (130 * (ivaPerc / 100)).toFixed(2);
    const ret = (130 * (retPerc / 100)).toFixed(2);

    const invoiceData = {
      numero: numFactura,
      fecha: new Date().toLocaleDateString('es-ES'),
      base: base.replace('.', ','),
      iva: iva.replace('.', ','),
      ret: ret.replace('.', ','),
      total: total.replace('.', ','),
      ivaPerc,
      retPerc
    };

    // 3. Enviar email
    const transporter = buildTransporter();
    const supportEmail = process.env.SUPPORT_EMAIL || 'contacto@tuappgo.com';
    const mail = buildPurchaseEmail({ code, expiresAt, supportEmail, invoiceData });

    await transporter.sendMail({
      from: requireEnv('SMTP_FROM'),
      to: customerEmail.trim(),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });

    await eventRef.set({ status: 'processed', invoice: numFactura, licenseCode: code }, { merge: true });
    return res.json({ received: true });

  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).send(err.message);
  }
}

module.exports = { stripeWebhookHandler };

