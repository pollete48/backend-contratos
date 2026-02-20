const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { generateUniqueLicenseCode } = require('./license-issue');

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

function safeTrim(v) { return String(v || '').trim(); }
function getPriceEurFromEnv() {
  const p = Number(process.env.PRICE_EUR || 0);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

async function getNextInvoiceNumber(db) {
  const yearNow = new Date().getFullYear();
  const counterRef = db.collection('metadata').doc('invoice_counter');

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    let nextNum = 1;
    if (snap.exists && snap.data().year === yearNow) {
      nextNum = (snap.data().current || 0) + 1;
    }
    tx.set(counterRef, { current: nextNum, year: yearNow });
    return `${nextNum}/${yearNow}`;
  });
}

function buildManualInvoiceHtml(invoiceData, code) {
  const emisor = {
    nombre: process.env.EMPRESA_NOMBRE || '',
    dni: process.env.EMPRESA_DNI || '',
    dir: process.env.EMPRESA_DIRECCION || '',
    tel: process.env.EMPRESA_TELEFONO || ''
  };

  return `
    <div style="margin-top:30px; border:1px solid #ddd; padding:20px; font-family:Arial, sans-serif; border-radius:8px; color:#333;">
      <table style="width:100%;">
        <tr>
          <td><img src="https://tuappgo.com/contratos/assets/logo-tuappgo.png" alt="Logo" style="height:60px;"></td>
          <td style="text-align:right; font-size:12px; color:#555;">
            <strong>EMISOR:</strong><br>${emisor.nombre}<br>${emisor.dni}<br>${emisor.dir}<br>${emisor.tel}
          </td>
        </tr>
      </table>
      <h3 style="margin-bottom:5px;">FACTURA: ${invoiceData.numero}</h3>
      <p style="font-size:13px; margin-top:0;">Fecha: ${invoiceData.fecha}</p>
      <table style="width:100%; border-collapse:collapse; margin-top:15px; font-size:14px;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:10px; border:1px solid #ddd; text-align:left;">Concepto</th>
            <th style="padding:10px; border:1px solid #ddd; text-align:right;">Base</th>
            <th style="padding:10px; border:1px solid #ddd; text-align:right;">IVA</th>
            <th style="padding:10px; border:1px solid #ddd; text-align:right;">IRPF</th>
            <th style="padding:10px; border:1px solid #ddd; text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:10px; border:1px solid #ddd;">Licencia App Generación de Contratos (Bizum/Transf)</td>
            <td style="padding:10px; border:1px solid #ddd; text-align:right;">${invoiceData.base}€</td>
            <td style="padding:10px; border:1px solid #ddd; text-align:right;">${invoiceData.iva}€</td>
            <td style="padding:10px; border:1px solid #ddd; text-align:right; color:#d9534f;">-${invoiceData.ret}€</td>
            <td style="padding:10px; border:1px solid #ddd; text-align:right; font-weight:bold;">${invoiceData.total}€</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

async function createManualOrderHandler(req, res) {
  try {
    const db = req.app?.locals?.db;
    const metodo = safeTrim(req.body?.metodo).toLowerCase();
    const email = safeTrim(req.body?.email);
    const amount = getPriceEurFromEnv();
    const referencia = `TUAPP-${Math.random().toString(36).toUpperCase().slice(2, 8)}`;
    await db.collection('manual_orders').add({ metodo, email: email.toLowerCase(), status: 'pending', amount, referencia, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ ok: true, orderId: referencia });
  } catch (err) { return res.status(500).json({ ok: false }); }
}

async function completeManualOrder(req, res) {
  try {
    const db = req.app?.locals?.db;
    const orderRef = db.collection('manual_orders').doc(req.params.id);
    const snap = await orderRef.get();
    const order = snap.data();

    const code = await generateUniqueLicenseCode(db, { collectionName: 'licenses' });
    const numFactura = await getNextInvoiceNumber(db);
    
    const invoiceData = {
      numero: numFactura, fecha: new Date().toLocaleDateString('es-ES'),
      base: "130,00", 
      iva: (130 * (parseFloat(process.env.IVA_PORCENTAJE)/100)).toFixed(2).replace('.', ','),
      ret: (130 * (parseFloat(process.env.RETENCION_PORCENTAJE)/100)).toFixed(2).replace('.', ','),
      total: getPriceEurFromEnv().toFixed(2).replace('.', ','),
    };

    const htmlBody = `<p>Su pago ha sido verificado. Licencia: <strong>${code}</strong></p>${buildManualInvoiceHtml(invoiceData, code)}`;

    await buildTransporter().sendMail({
      from: requireEnv('SMTP_FROM'),
      to: order.email,
      subject: 'Tu licencia y factura de TuAppGo',
      html: htmlBody
    });

    await orderRef.update({ status: 'license_sent', licenseCode: code, invoice: numFactura });
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ ok: false }); }
}

module.exports = { createManualOrderHandler, completeManualOrder };
