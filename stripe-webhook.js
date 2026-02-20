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
  const d = date?.toDate ? date.toDate() : (date instanceof Date ? date : new Date(date));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function buildPurchaseEmail({ code, expiresAt, supportEmail, invoiceData }) {
  const expires = formatDateES(expiresAt);
  
  const emisor = {
    nombre: process.env.EMPRESA_NOMBRE || '',
    dni: process.env.EMPRESA_DNI || '',
    dir: process.env.EMPRESA_DIRECCION || '',
    tel: process.env.EMPRESA_TELEFONO || '',
    email: process.env.EMPRESA_EMAIL || ''
  };

  const facturaHtml = `
    <div style="margin-top:30px; border:1px solid #ddd; padding:20px; font-family:Arial, sans-serif; border-radius:8px; color:#333; max-width: 500px;">
      <table style="width:100%;">
        <tr>
          <td style="vertical-align:top;">
            <img src="https://tuappgo.com/contratos/assets/logo-tuappgo.png" alt="TuAppGo" style="height:105px;">
          </td>
          <td style="text-align:right; font-size:12px; color:#555;">
            <strong>EMISOR:</strong><br>${emisor.nombre}<br>${emisor.dni}<br>${emisor.dir}<br>${emisor.tel}
          </td>
        </tr>
      </table>
      <div style="margin-top:20px;">
        <h3 style="margin-bottom:5px;">FACTURA: ${invoiceData.numero}</h3>
        <p style="font-size:13px; margin-top:0;">Fecha: ${invoiceData.fecha}</p>
      </div>
      <table style="width:100%; border-collapse:collapse; margin-top:15px; font-size:15px;">
        <tr>
          <td style="padding:10px; border-bottom:1px solid #eee;">Base Imponible</td>
          <td style="padding:10px; border-bottom:1px solid #eee; text-align:right;">${invoiceData.base}€</td>
        </tr>
        <tr>
          <td style="padding:10px; border-bottom:1px solid #eee;">IVA (${invoiceData.ivaPerc}%)</td>
          <td style="padding:10px; border-bottom:1px solid #eee; text-align:right;">${invoiceData.iva}€</td>
        </tr>
        <tr>
          <td style="padding:10px; border-bottom:1px solid #eee;">Retención IRPF (-${invoiceData.retPerc}%)</td>
          <td style="padding:10px; border-bottom:1px solid #eee; text-align:right; color:#d9534f;">-${invoiceData.ret}€</td>
        </tr>
        <tr style="font-weight:bold; background:#f9f9f9;">
          <td style="padding:10px; font-size:1.1em;">TOTAL</td>
          <td style="padding:10px; text-align:right; font-size:1.1em; color:#28a745;">${invoiceData.total}€</td>
        </tr>
      </table>
    </div>`;

  return {
    subject: 'Tu licencia y factura de TuAppGo',
    text: `Tuappgo agradece tu confianza.\n\nLicencia: ${code}\nFactura: ${invoiceData.numero}\nTotal: ${invoiceData.total}€`,
    html: `
      <div style="font-family:Arial, sans-serif; color:#333;">
        <p>Tuappgo te agradece tu confianza por tu compra.</p>
        <p><strong>Tu código de licencia:</strong><br>
        <span style="font-size:18px;letter-spacing:1px; color:#2a6edb;">${code}</span></p>
        <p><strong>Válida hasta:</strong> ${expires}</p>
        <p><strong>Cómo activar:</strong> Abre la app, ve a Ajustes → Licencia, pega el código y activa.</p>
        <p>Adjuntamos su factura detallada en formato PDF.</p>
        ${facturaHtml}
        <p style="margin-top:20px; font-size:12px; color:#777;">Soporte: ${supportEmail}</p>
      </div>`,
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
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  const db = req.app?.locals?.db;
  if (!db) return res.status(500).send('Firestore db no configurado');

  const eventRef = db.collection('stripe_events').doc(event.id);

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

    const existing = await db.collection('licenses').where('stripe.sessionId', '==', stripeSessionId).limit(1).get();
    if (!existing.empty) {
      await eventRef.set({ status: 'processed', note: 'License already exists' }, { merge: true });
      return res.json({ received: true });
    }

    const { code, expiresAt } = await createLicenseFromStripe(db, {
      email: customerEmail,
      stripeSessionId,
      paidAt: new Date(session.created * 1000),
      amountTotal: session.amount_total,
      currency: session.currency,
      collectionName: 'licenses',
    });

    const numFactura = await getNextInvoiceNumber(db);
    const ivaPerc = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retPerc = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    const baseVal = parseFloat(process.env.PRECIO_BASE || '130.00');
    const totalVal = session.amount_total / 100;
    
    const invoiceData = {
      numero: numFactura,
      fecha: new Date().toLocaleDateString('es-ES'),
      base: baseVal.toFixed(2).replace('.', ','),
      iva: (baseVal * (ivaPerc / 100)).toFixed(2).replace('.', ','),
      ret: (baseVal * (retPerc / 100)).toFixed(2).replace('.', ','),
      total: totalVal.toFixed(2).replace('.', ','),
      ivaPerc,
      retPerc
    };

    // REGISTRO EN EL LIBRO DE FACTURAS EMITIDAS
    await db.collection('invoices').doc(numFactura.replace('/', '-')).set({
      invoiceNumber: numFactura,
      date: admin.firestore.FieldValue.serverTimestamp(),
      email: customerEmail,
      base: baseVal,
      iva: parseFloat((baseVal * (ivaPerc / 100)).toFixed(2)),
      ret: parseFloat((baseVal * (retPerc / 100)).toFixed(2)),
      total: totalVal,
      method: 'stripe',
      stripeSessionId: stripeSessionId
    });

    const supportEmail = process.env.SUPPORT_EMAIL || 'contacto@tuappgo.com';
    const mailContent = buildPurchaseEmail({ code, expiresAt, supportEmail, invoiceData });

    const pdfBuffer = await htmlPdf.generatePdf({ content: mailContent.facturaSoloHtml }, { format: 'A4' });

    const transporter = buildTransporter();
    await transporter.sendMail({
      from: requireEnv('SMTP_FROM'),
      to: customerEmail.trim(),
      subject: mailContent.subject,
      text: mailContent.text,
      html: mailContent.html,
      attachments: [{
        filename: `Factura_${numFactura.replace('/', '-')}.pdf`,
        content: pdfBuffer
      }]
    });

    await eventRef.set({ status: 'processed', processedAt: new Date(), licenseCode: code, invoice: numFactura }, { merge: true });
    return res.json({ received: true });

  } catch (err) {
    await eventRef.set({ status: 'error', error: err.message, processedAt: new Date() }, { merge: true });
    return res.status(500).send(err.message);
  }
}

module.exports = { stripeWebhookHandler };
