// admin-panel.js
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const htmlPdf = require('html-pdf-node');
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

/**
 * Lógica de Contador de Factura con reseteo anual (Compartida)
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
 * Genera el Bloque HTML de la factura desglosada
 * Mejora 1: Logo 105px
 * Mejora 2: Disposición vertical descendente
 */
function buildInvoiceHtml(invoiceData) {
  const emisor = {
    nombre: process.env.EMPRESA_NOMBRE || '',
    dni: process.env.EMPRESA_DNI || '',
    dir: process.env.EMPRESA_DIRECCION || '',
    tel: process.env.EMPRESA_TELEFONO || '',
    email: process.env.EMPRESA_EMAIL || ''
  };

  return `
    <div style="margin-top:30px; border:1px solid #ddd; padding:20px; font-family:Arial, sans-serif; border-radius:8px; color:#333; max-width: 550px;">
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
          <td style="padding:10px 0; border-bottom:1px solid #eee;">Base Imponible</td>
          <td style="padding:10px 0; border-bottom:1px solid #eee; text-align:right;">${invoiceData.base}€</td>
        </tr>
        <tr>
          <td style="padding:10px 0; border-bottom:1px solid #eee;">IVA (${invoiceData.ivaPerc}%)</td>
          <td style="padding:10px 0; border-bottom:1px solid #eee; text-align:right;">${invoiceData.iva}€</td>
        </tr>
        <tr>
          <td style="padding:10px 0; border-bottom:1px solid #eee;">Retención IRPF (-${invoiceData.retPerc}%)</td>
          <td style="padding:10px 0; border-bottom:1px solid #eee; text-align:right; color:#d9534f;">-${invoiceData.ret}€</td>
        </tr>
        <tr style="font-weight:bold;">
          <td style="padding:15px 0; font-size:1.1em;">TOTAL PAGADO</td>
          <td style="padding:15px 0; text-align:right; font-size:1.1em; color:#28a745;">${invoiceData.total}€</td>
        </tr>
      </table>
    </div>
  `;
}

function buildPurchaseEmail({ code, expiresAt, invoiceData }) {
  const facturaHtml = buildInvoiceHtml(invoiceData);
  
  return {
    subject: 'Tu licencia y factura de TuAppGo',
    html: `
      <div style="font-family:Arial, sans-serif; color:#333;">
        <p>Tuappgo te agradece tu confianza por tu compra.</p>
        <p><strong>Tu código de licencia:</strong><br>
        <span style="font-size:18px;letter-spacing:1px; color:#2a6edb;">${code}</span></p>
        <p><strong>Válida hasta:</strong> ${invoiceData.fecha}</p>
        <p><strong>Cómo activar:</strong><br>
        1) Abre la app<br>
        2) Ajustes → Licencia<br>
        3) Pega el código y activa</p>
        
        <p>Adjuntamos a este email su factura detallada en formato PDF.</p>
        ${facturaHtml}
        
        <p style="margin-top:20px;"><strong>Importante:</strong><br>
        - La licencia es para 1 dispositivo.<br>
        - Incluye 1 cambio de dispositivo al año.</p>
      </div>
    `,
    facturaSoloHtml: `<html><body>${facturaHtml}</body></html>`
  };
}

function emailSignatureHtml() {
  return `
  <div style="margin-top:20px; font-family:Arial, sans-serif; font-size:13px; color:#555;">
    <hr style="border:none; border-top:1px solid #eee; margin-bottom:15px;" />
    <strong>TuAppGo</strong><br />
    Automatización de contratos y documentos<br />
    <a href="https://tuappgo.com" style="color:#2a6edb; text-decoration:none;">https://tuappgo.com</a><br />
    <span style="color:#777;">contacto@tuappgo.com</span>
  </div>
`;
}

function requireAdmin(req, res, next) {
  const key = String(req.headers['x-admin-key'] || '').trim();
  const expected = String(process.env.ADMIN_KEY || '').trim();
  if (!expected) return res.status(500).json({ ok: false, code: 'ADMIN_KEY_NOT_SET' });
  if (!key || key !== expected) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
  next();
}

function getPriceEur() {
  const p = Number(process.env.PRICE_EUR || 0);
  return Number.isFinite(p) ? p : 0;
}

function getBaseImponible() {
  const b = Number(process.env.PRECIO_BASE || 130.00);
  return Number.isFinite(b) ? b : 130.00;
}

async function listManualOrders(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(503).json({ ok: false, code: 'FIRESTORE_NOT_READY' });

    const status = String(req.query?.status || 'pending');
    const q = db.collection('manual_orders').where('status', '==', status).limit(200);

    const snap = await q.get();
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    items.sort((a, b) => {
      const aSec = a?.createdAt?._seconds ?? 0;
      const bSec = b?.createdAt?._seconds ?? 0;
      return bSec - aSec;
    });

    return res.json({ ok: true, items, priceEur: getPriceEur() });
  } catch (err) {
    console.error('❌ listManualOrders', err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR' });
  }
}

async function completeManualOrder(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(503).json({ ok: false, code: 'FIRESTORE_NOT_READY' });

    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, code: 'MISSING_ID' });

    const orderRef = db.collection('manual_orders').doc(id);

    const order = await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists) throw new Error('ORDER_NOT_FOUND');
      const o = snap.data() || {};
      if (o.status !== 'pending') throw new Error('ORDER_NOT_PENDING');

      tx.update(orderRef, {
        status: 'paid_processing',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        amount: getPriceEur(),
        currency: 'EUR',
      });
      return { id: snap.id, ...o };
    });

    const email = String(order.email || '').trim().toLowerCase();
    
    // Generar licencia
    const paidAtDate = new Date();
    const expiresAtDate = new Date(paidAtDate);
    expiresAtDate.setFullYear(expiresAtDate.getFullYear() + 1);
    const code = await generateUniqueLicenseCode(db, { collectionName: 'licenses' });

    const licRef = db.collection('licenses').doc(code);
    
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(licRef);
      if (snap.exists) throw new Error('LICENSE_COLLISION');
      tx.create(licRef, {
        code, email, status: 'active',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: admin.firestore.Timestamp.fromDate(paidAtDate),
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAtDate),
        activatedUuid: null, activatedAt: null,
        deviceChangeUsed: false, deviceChangedAt: null,
        recoveryUsed: false, recoveryUsedAt: null,
        source: 'manual',
        manual: { orderId: id, metodo: order.metodo || null, referencia: order.referencia || null },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // --- LÓGICA DE FACTURA ---
    const numFactura = await getNextInvoiceNumber(db);
    const ivaPerc = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retPerc = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    
    const totalVal = getPriceEur();
    const baseVal = getBaseImponible();
    const total = totalVal.toFixed(2);
    const base = baseVal.toFixed(2);
    const iva = (baseVal * (ivaPerc / 100)).toFixed(2);
    const ret = (baseVal * (retPerc / 100)).toFixed(2);

    const invoiceData = {
      numero: numFactura,
      fecha: new Date().toLocaleDateString('es-ES'),
      base: base.replace('.', ','),
      iva: iva.replace('.', ','),
      ret: ret.replace('.', ','),
      total: total.replace('.', ','),
      ivaPerc, retPerc
    };

    // REGISTRO EN EL LIBRO DE FACTURAS EMITIDAS
    await db.collection('invoices').doc(numFactura.replace('/', '-')).set({
      invoiceNumber: numFactura,
      date: admin.firestore.FieldValue.serverTimestamp(),
      email: email,
      base: parseFloat(base),
      iva: parseFloat(iva),
      ret: parseFloat(ret),
      total: parseFloat(total),
      method: order.metodo || 'manual',
      orderId: id
    });

    const mail = buildPurchaseEmail({ code, expiresAt: expiresAtDate, invoiceData });
    const finalHtml = `${mail.html}${emailSignatureHtml()}`;

    // Mejora 3: Generar PDF
    const pdfBuffer = await htmlPdf.generatePdf({ content: mail.facturaSoloHtml }, { format: 'A4' });

    const transporter = buildTransporter();
    try {
      await transporter.sendMail({
        from: requireEnv('SMTP_FROM'),
        to: email,
        subject: mail.subject,
        html: finalHtml,
        attachments: [{
          filename: `Factura_${numFactura.replace('/', '-')}.pdf`,
          content: pdfBuffer
        }]
      });
    } catch (mailErr) {
      await orderRef.update({
        status: 'license_created_email_failed',
        licenseCode: code,
        emailError: String(mailErr.message || mailErr),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ ok: true, licenseCode: code, warning: 'EMAIL_FAILED' });
    }

    await orderRef.update({
      status: 'license_sent',
      licenseCode: code,
      invoice: numFactura,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, licenseCode: code });
  } catch (err) {
    console.error('❌ completeManualOrder', err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR' });
  }
}

function adminHtmlPage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>TuAppGo Admin</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; margin:0; background:#0b1220; color:#e8eefc;}
    header{padding:18px 20px; background:#0f1b33; border-bottom:1px solid rgba(255,255,255,.08);}
    h1{margin:0; font-size:18px;}
    main{max-width:1000px; margin:0 auto; padding:18px;}
    .card{background:#0f1b33; border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:14px; margin-bottom:12px;}
    .row{display:flex; gap:10px; flex-wrap:wrap; align-items:center;}
    input,select{background:#0b1220; color:#e8eefc; border:1px solid rgba(255,255,255,.14); border-radius:10px; padding:10px 12px;}
    button{border:0; border-radius:12px; padding:10px 12px; cursor:pointer; font-weight:700;}
    .btn{background:#2a6edb; color:white;}
    .btn2{background:#22c55e; color:#07121e;}
    .btn3{background:#334155; color:#e8eefc;}
    table{width:100%; border-collapse:collapse; margin-top:10px;}
    th,td{padding:10px; border-bottom:1px solid rgba(255,255,255,.08); font-size:13px; vertical-align:top;}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;}
    .pill{display:inline-block; padding:4px 8px; border-radius:999px; background:rgba(255,255,255,.10); font-size:12px;}
  </style>
</head>
<body>
<header><h1>TuAppGo Admin — Pagos manuales</h1></header>
<main>
  <div class="card">
    <div class="row">
      <input id="key" type="password" placeholder="ADMIN_KEY" style="flex:1; min-width:240px;">
      <select id="status">
        <option value="pending">Pendientes</option>
        <option value="license_sent">Enviadas</option>
        <option value="paid_processing">Procesando</option>
        <option value="error">Error</option>
      </select>
      <button class="btn" onclick="saveKey()">Guardar clave</button>
      <button class="btn3" onclick="load()">Cargar</button>
    </div>
  </div>
  <div class="card">
    <div id="msg" class="muted">Lista de pedidos</div>
    <div style="overflow:auto;">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Método</th>
            <th>Email</th>
            <th>Referencia</th>
            <th>Estado</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>
</main>
<script>
  const KEY_LS = 'tuappgo_admin_key';
  const keyInput = document.getElementById('key');
  const statusSel = document.getElementById('status');
  const rowsEl = document.getElementById('rows');
  const msgEl = document.getElementById('msg');
  keyInput.value = localStorage.getItem(KEY_LS) || '';
  function saveKey(){ localStorage.setItem(KEY_LS, keyInput.value.trim()); msgEl.textContent = 'Clave guardada.'; }
  async function api(path, opts={}){
    const key = (localStorage.getItem(KEY_LS) || '').trim();
    const headers = Object.assign({'x-admin-key': key}, opts.headers || {});
    const r = await fetch(path, Object.assign({}, opts, {headers}));
    const j = await r.json();
    if(!r.ok) throw new Error(j.code || 'ERROR');
    return j;
  }
  async function load(){
    rowsEl.innerHTML = 'Cargando...';
    try{
      const j = await api('/api/admin/manual-orders?status=' + statusSel.value);
      rowsEl.innerHTML = (j.items || []).map(o => \`
        <tr>
          <td>\${new Date(o.createdAt._seconds*1000).toLocaleString()}</td>
          <td>\${o.metodo}</td>
          <td>\${o.email}</td>
          <td>\${o.referencia}</td>
          <td>\${o.status}</td>
          <td>\${o.status==='pending' ? '<button class="btn2" onclick="complete(\\''+o.id+'\\')">Confirmar pago y enviar factura</button>':''}</td>
        </tr>\`).join('');
    }catch(e){ msgEl.textContent = e.message; }
  }
  async function complete(id){
    if(!confirm('¿Enviar factura y licencia?')) return;
    try{ await api('/api/admin/manual-orders/'+id+'/complete', {method:'POST'}); load(); }
    catch(e){ alert(e.message); }
  }
  load();
</script>
</body>
</html>`;
}

function adminPageHandler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(adminHtmlPage());
}

module.exports = { requireAdmin, listManualOrders, completeManualOrder, adminPageHandler };
