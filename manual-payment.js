const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const htmlPdf = require('html-pdf-node');
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

/**
 * Genera el diseño de la factura y el cuerpo del email
 */
function buildManualInvoiceTemplate(invoiceData, code, supportEmail) {
  const emisor = {
    nombre: process.env.EMPRESA_NOMBRE || '',
    dni: process.env.EMPRESA_DNI || '',
    dir: process.env.EMPRESA_DIRECCION || '',
    tel: process.env.EMPRESA_TELEFONO || ''
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

  return {
    html: `
      <div style="font-family:Arial, sans-serif; color:#333;">
        <p>Tuappgo te agradece tu confianza. Hemos verificado tu pago manual correctamente.</p>
        <p><strong>Tu código de licencia:</strong><br>
        <span style="font-size:18px;letter-spacing:1px; color:#2a6edb;">${code}</span></p>
        <p>Ajustes → Licencia para activar. Adjuntamos factura detallada en PDF.</p>
        ${facturaHtml}
        <p style="margin-top:20px; font-size:12px; color:#777;">Soporte: ${supportEmail}</p>
      </div>
    `,
    facturaSoloHtml: `<html><body>${facturaHtml}</body></html>`
  };
}

/**
 * 1. Crea la orden pendiente (Desde el cliente)
 */
async function createManualOrder(req, res) {
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('manual_orders').add(orderDoc);

    return res.json({
      ok: true,
      orderId: ref.id,
      referencia,
      amount
    });
  } catch (err) {
    console.error('[createManualOrder] Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * 2. Completa la orden, genera licencia y envía factura (Desde Admin Panel)
 */
async function completeManualOrder(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(500).json({ ok: false, error: 'Database not initialized' });

    const orderId = req.params.id;
    if (!orderId) return res.status(400).json({ ok: false, error: 'Falta Order ID' });

    const orderRef = db.collection('manual_orders').doc(orderId);
    const snap = await orderRef.get();

    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    
    const orderData = snap.data();
    if (orderData.status === 'license_sent') {
      return res.status(400).json({ ok: false, error: 'Esta orden ya ha sido procesada' });
    }

    // A. Generar Licencia
    const code = await generateUniqueLicenseCode(db, { collectionName: 'licenses' });
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    await db.collection('licenses').add({
      code,
      email: orderData.email,
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      type: 'manual',
      orderId: orderId
    });

    // B. Generar Factura
    const numFactura = await getNextInvoiceNumber(db);
    const ivaPerc = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retPerc = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    const totalEur = orderData.amount || getPriceEurFromEnv();
    
    const invoiceData = {
      numero: numFactura,
      fecha: new Date().toLocaleDateString('es-ES'),
      base: "130,00",
      iva: (130 * (ivaPerc / 100)).toFixed(2).replace('.', ','),
      ret: (130 * (retPerc / 100)).toFixed(2).replace('.', ','),
      total: totalEur.toFixed(2).replace('.', ','),
      ivaPerc,
      retPerc
    };

    const supportEmail = process.env.SUPPORT_EMAIL || 'contacto@tuappgo.com';
    const templates = buildManualInvoiceTemplate(invoiceData, code, supportEmail);

    // C. Generar PDF
    const pdfBuffer = await htmlPdf.generatePdf({ content: templates.facturaSoloHtml }, { format: 'A4' });

    // D. Enviar Email
    const transporter = buildTransporter();
    const emailSignatureHtml = `
      <hr style="margin-top:30px; border:none; border-top:1px solid #e0e0e0;" />
      <div style="margin-top:20px; font-family:Arial, sans-serif; font-size:13px; color:#555;">
        <img src="https://tuappgo.com/contratos/assets/logo-tuappgo.png" alt="TuAppGo" style="height:80px; display:block; margin-bottom:12px;" />
        <strong>TuAppGo</strong><br />
        <a href="https://tuappgo.com" style="color:#2a6edb; text-decoration:none;">https://tuappgo.com</a>
      </div>
    `;

    await transporter.sendMail({
      from: requireEnv('SMTP_FROM'),
      to: orderData.email,
      subject: 'Tu licencia y factura de TuAppGo (Pago Manual)',
      html: `${templates.html}${emailSignatureHtml}`,
      attachments: [{
        filename: `Factura_${numFactura.replace('/', '-')}.pdf`,
        content: pdfBuffer
      }]
    });

    // E. Actualizar Orden
    await orderRef.update({
      status: 'license_sent',
      licenseCode: code,
      invoice: numFactura,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, licenseCode: code, invoice: numFactura });

  } catch (err) {
    console.error('[completeManualOrder] Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * Exportaciones alineadas con el archivo de rutas
 */
module.exports = {
  createManualOrder,
  completeManualOrder
};
