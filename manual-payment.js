const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { generateUniqueLicenseCode } = require('./license-issue');

/**
 * Utilidades de Configuración
 */
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

function safeTrim(v) {
  return String(v || '').trim();
}

function getPriceEurFromEnv() {
  const p = Number(process.env.PRICE_EUR || 0);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

/**
 * Contador de Facturas con reseteo anual
 */
async function getNextInvoiceNumber(db) {
  const yearNow = new Date().getFullYear();
  const counterRef = db.collection('metadata').doc('invoice_counter');

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    let nextNum = 1;

    if (snap.exists) {
      const data = snap.data();
      if (data.year === yearNow) {
        nextNum = (data.current || 0) + 1;
      }
    }

    tx.set(counterRef, { current: nextNum, year: yearNow });
    return `${nextNum}/${yearNow}`;
  });
}

/**
 * Genera el diseño de la factura HTML (Versión original en tabla)
 */
function buildManualInvoiceHtml(invoiceData) {
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
          <td style="vertical-align:top;">
            <img src="https://tuappgo.com/contratos/assets/logo-tuappgo.png" alt="Logo" style="height:60px;">
          </td>
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
            <td style="padding:10px; border:1px solid #ddd;">Licencia App Generación de Contratos (Pago Manual)</td>
            <td style="padding:10px; border:1px solid #ddd; text-align:right;">${invoiceData.base}€</td>
            <td style="padding:10px; border:1px solid #ddd; text-align:right;">${invoiceData.iva}€</td>
            <td style="padding:10px; border:1px solid #ddd; text-align:right; color:#d9534f;">-${invoiceData.ret}€</td>
            <td style="padding:10px; border:1px solid #ddd; text-align:right; font-weight:bold;">${invoiceData.total}€</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

/**
 * 1. Crea la orden pendiente (Desde el cliente)
 */
async function createManualOrderHandler(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(500).json({ ok: false, error: 'Database not initialized' });

    const metodo = safeTrim(req.body?.metodo).toLowerCase();
    const email = safeTrim(req.body?.email);

    if (!email || !metodo) {
      return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios' });
    }

    const amount = getPriceEurFromEnv();
    const referencia = `TUAPP-${Math.random().toString(36).toUpperCase().slice(2, 8)}`;

    const orderDoc = {
      metodo,
      email: email.toLowerCase(),
      status: 'pending',
      amount,
      referencia,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('manual_orders').add(orderDoc);

    // Es vital devolver el ID del documento (ref.id) para que la app lo use en el polling
    return res.json({
      ok: true,
      orderId: ref.id,
      referencia: referencia,
      amount: amount
    });
  } catch (err) {
    console.error('[createManualOrderHandler] Error:', err);
    return res.status(500).json({ ok: false });
  }
}

/**
 * 2. Completa la orden (Desde Admin Panel)
 */
async function completeManualOrder(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(500).json({ ok: false, error: 'Database not initialized' });

    const orderId = req.params.id;
    const orderRef = db.collection('manual_orders').doc(orderId);
    const snap = await orderRef.get();

    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    
    const orderData = snap.data();
    if (orderData.status === 'license_sent') {
      return res.status(400).json({ ok: false, error: 'Ya procesada' });
    }

    const code = await generateUniqueLicenseCode(db, { collectionName: 'licenses' });
    const numFactura = await getNextInvoiceNumber(db);
    
    const ivaP = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retP = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    
    const invoiceData = {
      numero: numFactura,
      fecha: new Date().toLocaleDateString('es-ES'),
      base: "130,00",
      iva: (130 * (ivaP / 100)).toFixed(2).replace('.', ','),
      ret: (130 * (retP / 100)).toFixed(2).replace('.', ','),
      total: getPriceEurFromEnv().toFixed(2).replace('.', ','),
    };

    const htmlBody = `<p>Su pago ha sido verificado. Licencia: <strong>${code}</strong></p>${buildManualInvoiceHtml(invoiceData)}`;

    const transporter = buildTransporter();
    await transporter.sendMail({
      from: requireEnv('SMTP_FROM'),
      to: orderData.email,
      subject: 'Tu licencia y factura de TuAppGo',
      html: htmlBody
    });

    await orderRef.update({
      status: 'license_sent',
      licenseCode: code,
      invoice: numFactura,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[completeManualOrder] Error:', err);
    return res.status(500).json({ ok: false });
  }
}

module.exports = {
  createManualOrderHandler,
  completeManualOrder
};
