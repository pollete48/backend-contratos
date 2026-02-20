const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const htmlPdf = require('html-pdf-node'); // Mejora 3: PDF
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

function genReferencia(prefix = 'TUAPP') {
  const rnd = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return `${prefix}-${rnd}`;
}

function safeTrim(v) {
  return String(v || '').trim();
}

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

function buildManualInvoiceHtml(invoiceData) {
  const emisor = {
    nombre: process.env.EMPRESA_NOMBRE || '',
    dni: process.env.EMPRESA_DNI || '',
    dir: process.env.EMPRESA_DIRECCION || '',
    tel: process.env.EMPRESA_TELEFONO || ''
  };

  // Mejora 1: Logo 105px
  // Mejora 2: Disposición vertical descendente
  return `
    <div style="margin-top:30px; border:1px solid #ddd; padding:20px; font-family:Arial, sans-serif; border-radius:8px; color:#333; max-width: 500px;">
      <table style="width:100%;">
        <tr>
          <td><img src="https://tuappgo.com/contratos/assets/logo-tuappgo.png" alt="Logo" style="height:105px;"></td>
          <td style="text-align:right; font-size:12px; color:#555;">
            <strong>EMISOR:</strong><br>${emisor.nombre}<br>${emisor.dni}<br>${emisor.dir}<br>${emisor.tel}
          </td>
        </tr>
      </table>
      <h3 style="margin-bottom:5px;">FACTURA: ${invoiceData.numero}</h3>
      <p style="font-size:13px; margin-top:0;">Fecha: ${invoiceData.fecha}</p>
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
}

async function createManualOrderHandler(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(503).json({ ok: false, code: 'FIRESTORE_NOT_READY' });

    const metodo = safeTrim(req.body?.metodo).toLowerCase();
    const email = safeTrim(req.body?.email);
    const uuid = safeTrim(req.body?.uuid);
    const producto = safeTrim(req.body?.producto || 'contratos');

    if (!['bizum', 'transferencia'].includes(metodo)) {
      return res.status(400).json({ ok: false, code: 'INVALID_METHOD' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ ok: false, code: 'INVALID_EMAIL' });
    }

    const amount = getPriceEurFromEnv();
    const prefix = metodo === 'bizum' ? 'TUAPP-BIZ' : 'TUAPP-TRF';
    const referencia = genReferencia(prefix);

    const bizumPhone = safeTrim(process.env.BIZUM_PHONE);
    const bankIban = safeTrim(process.env.BANK_IBAN);
    const bankHolder = safeTrim(process.env.BANK_HOLDER);
    const bankConceptHint = safeTrim(process.env.BANK_CONCEPT_HINT);

    if (metodo === 'bizum' && !bizumPhone) return res.status(500).json({ ok: false, code: 'BIZUM_PHONE_NOT_SET' });
    if (metodo === 'transferencia' && !bankIban) return res.status(500).json({ ok: false, code: 'BANK_IBAN_NOT_SET' });
    if (amount <= 0) return res.status(500).json({ ok: false, code: 'PRICE_EUR_NOT_SET' });

    const now = admin.firestore.FieldValue.serverTimestamp();
    const doc = {
      metodo, email: email.toLowerCase(), uuid: uuid || null, producto,
      amount, currency: 'EUR', referencia, status: 'pending',
      createdAt: now, updatedAt: now,
      ivaPerc: parseFloat(process.env.IVA_PORCENTAJE || '21'),
      retPerc: parseFloat(process.env.RETENCION_PORCENTAJE || '7')
    };

    const ref = await db.collection('manual_orders').add(doc);
    const base = { metodo, referencia, amount, currency: 'EUR' };
    const instrucciones = metodo === 'bizum' ? { ...base, bizumPhone } : { ...base, bankIban, bankHolder, bankConceptHint };

    return res.json({ ok: true, orderId: ref.id, instrucciones });
  } catch (err) {
    console.error('❌ createManualOrderHandler error:', err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR' });
  }
}

async function completeManualOrder(req, res) {
  try {
    const db = req.app?.locals?.db;
    const orderRef = db.collection('manual_orders').doc(req.params.id);
    const snap = await orderRef.get();
    const order = snap.data();

    const code = await generateUniqueLicenseCode(db, { collectionName: 'licenses' });
    const numFactura = await getNextInvoiceNumber(db);
    const ivaP = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retP = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    
    const invoiceData = {
      numero: numFactura, fecha: new Date().toLocaleDateString('es-ES'),
      base: "130,00", 
      iva: (130 * (ivaP / 100)).toFixed(2).replace('.', ','),
      ret: (130 * (retP / 100)).toFixed(2).replace('.', ','),
      total: getPriceEurFromEnv().toFixed(2).replace('.', ','),
      ivaPerc: ivaP,
      retPerc: retP
    };

    const facturaSoloHtml = `<html><body>${buildManualInvoiceHtml(invoiceData)}</body></html>`;
    const htmlBody = `<p>Su pago ha sido verificado. Licencia: <strong>${code}</strong></p><p>Adjuntamos factura detallada en PDF.</p>${buildManualInvoiceHtml(invoiceData)}`;

    // Mejora 3: Generar PDF
    const pdfBuffer = await htmlPdf.generatePdf({ content: facturaSoloHtml }, { format: 'A4' });

    await buildTransporter().sendMail({
      from: requireEnv('SMTP_FROM'),
      to: order.email,
      subject: 'Tu licencia y factura de TuAppGo',
      html: htmlBody,
      attachments: [{
        filename: `Factura_${numFactura.replace('/', '-')}.pdf`,
        content: pdfBuffer
      }]
    });

    await orderRef.update({ status: 'license_sent', licenseCode: code, invoice: numFactura });
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ ok: false }); }
}

module.exports = { createManualOrderHandler, completeManualOrder };
