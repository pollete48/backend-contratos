// manual-payment.js
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const htmlPdf = require('html-pdf-node');
const { generateUniqueLicenseCode } = require('./license-issue');

/**
 * Utilidades de validación de entorno
 */
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

/**
 * Configuración del transporte de email
 */
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
 * Gestión del contador de facturas (con bloqueo de transacción)
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
 * Plantilla de Factura: Logo 30% más grande y Tabla Descendente
 */
function buildInvoiceTemplate(invoiceData, code, supportEmail) {
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
    htmlBody: `
      <div style="font-family:Arial, sans-serif; color:#333;">
        <p>Tuappgo agradece su confianza y le informa de que su pago manual ha sido verificado con éxito.</p>
        <p><strong>Su código de licencia:</strong><br>
        <span style="font-size:18px;letter-spacing:1px; color:#2a6edb;">${code}</span></p>
        <p>Adjuntamos a este email su factura detallada en formato PDF.</p>
        ${facturaHtml}
        <p style="margin-top:20px; font-size:12px; color:#777;">Soporte: ${supportEmail}</p>
      </div>
    `,
    facturaSoloHtml: `<html><body>${facturaHtml}</body></html>`
  };
}

/**
 * Paso 1: El usuario solicita pago manual (crea orden pendiente)
 */
async function createManualOrder(req, res) {
  try {
    const db = req.app?.locals?.db;
    const { email, method } = req.body;
    if (!email || !method) return res.status(400).json({ ok: false, error: 'Faltan datos' });

    const newOrder = {
      email: email.toLowerCase().trim(),
      method: method, // 'bizum' o 'transferencia'
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      priceEur: Number(process.env.PRICE_EUR || 135)
    };

    const docRef = await db.collection('manual_orders').add(newOrder);
    return res.json({ ok: true, orderId: docRef.id });
  } catch (err) {
    console.error('Error createManualOrder:', err);
    return res.status(500).json({ ok: false });
  }
}

/**
 * Paso 2: El admin confirma el pago (genera licencia, factura y PDF)
 */
async function confirmManualOrder(req, res) {
  try {
    const db = req.app?.locals?.db;
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId requerido' });

    const orderRef = db.collection('manual_orders').doc(orderId);
    
    // Transacción para asegurar que no se procese dos veces
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists) throw new Error('Orden no encontrada');
      if (snap.data().status !== 'pending') throw new Error('La orden ya ha sido procesada');

      const orderData = snap.data();
      const code = await generateUniqueLicenseCode(db, { collectionName: 'licenses' });
      const numFactura = await getNextInvoiceNumber(db);

      tx.update(orderRef, {
        status: 'completed',
        licenseCode: code,
        invoiceNumber: numFactura,
        confirmedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return { orderData, code, numFactura };
    });

    const { orderData, code, numFactura } = result;

    // Cálculos de factura
    const ivaP = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retP = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    const totalVal = orderData.priceEur || Number(process.env.PRICE_EUR || 135);
    
    // Cálculos basados en la base de 130€
    const invoiceData = {
      numero: numFactura,
      fecha: new Date().toLocaleDateString('es-ES'),
      base: "130,00",
      iva: (130 * (ivaP / 100)).toFixed(2).replace('.', ','),
      ret: (130 * (retP / 100)).toFixed(2).replace('.', ','),
      total: totalVal.toFixed(2).replace('.', ','),
      ivaPerc: ivaP,
      retPerc: retP
    };

    const supportEmail = process.env.SUPPORT_EMAIL || 'contacto@tuappgo.com';
    const templates = buildInvoiceTemplate(invoiceData, code, supportEmail);

    // Generación de PDF
    const pdfBuffer = await htmlPdf.generatePdf(
      { content: templates.facturaSoloHtml }, 
      { format: 'A4', margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } }
    );

    // Envío de Email
    const transporter = buildTransporter();
    await transporter.sendMail({
      from: requireEnv('SMTP_FROM'),
      to: orderData.email,
      subject: 'Pago confirmado - Tu licencia y factura TuAppGo',
      html: templates.htmlBody,
      attachments: [
        {
          filename: `Factura_${numFactura.replace('/', '-')}.pdf`,
          content: pdfBuffer
        }
      ]
    });

    return res.json({ ok: true, licenseCode: code, invoiceNumber: numFactura });

  } catch (err) {
    console.error('Error confirmManualOrder:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  createManualOrder,
  confirmManualOrder
};
