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

function buildInvoiceHtml(invoiceData) {
  const emisor = {
    nombre: process.env.EMPRESA_NOMBRE || '',
    dni: process.env.EMPRESA_DNI || '',
    dir: process.env.EMPRESA_DIRECCION || '',
    tel: process.env.EMPRESA_TELEFONO || '',
    email: process.env.EMPRESA_EMAIL || ''
  };

  const receptorHtml = invoiceData.nifFactura ? `
    <div style="margin-top:20px; font-size:12px; color:#555; text-align:left;">
      <strong>RECEPTOR:</strong><br>
      ${invoiceData.nombreFactura || ''}<br>
      NIF: ${invoiceData.nifFactura}<br>
      ${invoiceData.direccionFactura || ''}
    </div>
  ` : '';

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
      
      ${receptorHtml}

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
    items.sort((a, b) => (b?.createdAt?._seconds ?? 0) - (a?.createdAt?._seconds ?? 0));
    return res.json({ ok: true, items, priceEur: getPriceEur() });
  } catch (err) {
    console.error('❌ listManualOrders', err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR' });
  }
}

async function listInvoices(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(503).json({ ok: false, code: 'FIRESTORE_NOT_READY' });

    let q = db.collection('invoices').orderBy('date', 'desc');

    const { startDate, endDate } = req.query;
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      q = q.where('date', '>=', admin.firestore.Timestamp.fromDate(start));
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      q = q.where('date', '<=', admin.firestore.Timestamp.fromDate(end));
    }

    const snap = await q.limit(1000).get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('❌ listInvoices', err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', error: err.message });
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
        amount: o.amount || getPriceEur(),
        currency: 'EUR',
      });
      return { id: snap.id, ...o };
    });

    const email = String(order.email || '').trim().toLowerCase();
    const paidAtDate = new Date();
    const expiresAtDate = new Date(paidAtDate);
    expiresAtDate.setFullYear(expiresAtDate.getFullYear() + 1);
    const code = await generateUniqueLicenseCode(db, { collectionName: 'licenses' });
    const licRef = db.collection('licenses').doc(code);
    
    await db.runTransaction(async (tx) => {
      tx.create(licRef, {
        code, email, status: 'active',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: admin.firestore.Timestamp.fromDate(paidAtDate),
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAtDate),
        source: 'manual',
        manual: { orderId: id, metodo: order.metodo || null, referencia: order.referencia || null },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    const numFactura = await getNextInvoiceNumber(db);
    const ivaPerc = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retPerc = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    
    const totalVal = order.amount || getPriceEur();
    const baseVal = getBaseImponible();
    const ivaVal = parseFloat((baseVal * (ivaPerc / 100)).toFixed(2));
    const retVal = order.tipoCliente === 'profesional' ? parseFloat((baseVal * (retPerc / 100)).toFixed(2)) : 0;

    const invoiceData = {
      numero: numFactura,
      fecha: new Date().toLocaleDateString('es-ES'),
      base: baseVal.toFixed(2).replace('.', ','),
      iva: ivaVal.toFixed(2).replace('.', ','),
      ret: retVal.toFixed(2).replace('.', ','),
      total: totalVal.toFixed(2).replace('.', ','),
      ivaPerc, retPerc,
      nombreFactura: order.nombreFactura || '',
      nifFactura: order.nifFactura || '',
      direccionFactura: order.direccionFactura || ''
    };

    await db.collection('invoices').doc(numFactura.replace('/', '-')).set({
      invoiceNumber: numFactura,
      date: admin.firestore.FieldValue.serverTimestamp(),
      email,
      base: baseVal,
      iva: ivaVal,
      ret: retVal,
      total: totalVal,
      method: order.metodo || 'manual',
      orderId: id,
      tipoCliente: order.tipoCliente || 'particular',
      nombreFactura: order.nombreFactura || '',
      nifFactura: order.nifFactura || '',
      direccionFactura: order.direccionFactura || ''
    });

    const mail = buildPurchaseEmail({ code, expiresAt: expiresAtDate, invoiceData });
    const pdfBuffer = await htmlPdf.generatePdf({ content: mail.facturaSoloHtml }, { format: 'A4' });
    const transporter = buildTransporter();
    
    await transporter.sendMail({
      from: requireEnv('SMTP_FROM'),
      to: email,
      subject: mail.subject,
      html: `${mail.html}${emailSignatureHtml()}`,
      attachments: [{ filename: `Factura_${numFactura.replace('/', '-')}.pdf`, content: pdfBuffer }]
    });

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
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; margin:0; background:#0b1220; color:#e8eefc; overflow-x:hidden;}
    header{padding:18px 20px; background:#0f1b33; border-bottom:1px solid rgba(255,255,255,.08); display:flex; justify-content:space-between; align-items:center; position:sticky; top:0; z-index:100;}
    .nav-tabs{display:flex; gap:10px; margin: 20px 18px 10px 18px;}
    .tab{padding:10px 20px; cursor:pointer; border-radius:10px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); transition: 0.2s;}
    .tab.active{background:#2a6edb; border-color:#2a6edb; box-shadow: 0 4px 12px rgba(42, 110, 219, 0.2);}
    main{max-width:1200px; margin:0 auto; padding:18px; min-height: 80vh;}
    .card{background:#0f1b33; border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:14px; margin-bottom:12px;}
    .row{display:flex; gap:10px; flex-wrap:wrap; align-items:center;}
    input,select{background:#0b1220; color:#e8eefc; border:1px solid rgba(255,255,255,.14); border-radius:10px; padding:10px 12px; font-size:13px;}
    button{border:0; border-radius:12px; padding:10px 12px; cursor:pointer; font-weight:700; transition:0.2s;}
    button:active{transform:scale(0.96);}
    .btn{background:#2a6edb; color:white;}
    .btn2{background:#22c55e; color:#07121e;}
    .btn-csv{background:#f59e0b; color:#07121e;}
    .btn-outline{background:transparent; border:1px solid #2a6edb; color:#2a6edb;}
    .scroll-area{overflow-x:auto; width:100%; border-radius: 8px;}
    table{width:100%; border-collapse:collapse; margin-top:10px; min-width: 900px;}
    th,td{padding:12px; border-bottom:1px solid rgba(255,255,255,.08); font-size:13px; text-align:left;}
    th{background:rgba(255,255,255,.03); color: #94a3b8; font-weight: 600;}
    tfoot{font-weight:bold; background:rgba(255,255,255,.05); color: #fff;}
    .hidden{display:none;}
    .pill{padding: 4px 8px; border-radius: 6px; background: rgba(255,255,255,0.1); font-size: 11px;}
    .pill-pro{background: rgba(34, 197, 94, 0.2); color: #22c55e;}
    .filter-group{display:flex; gap:8px; align-items:center; background:rgba(255,255,255,0.02); padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,0.05);}
    .filter-label{font-size:12px; color:#94a3b8; margin-right:4px;}
  </style>
</head>
<body>
<header>
  <h1>TuAppGo Admin</h1>
  <div id="admin-key-area"><input id="key" type="password" placeholder="ADMIN_KEY" onchange="saveKey()"></div>
</header>

<div class="nav-tabs">
  <div id="tab-orders" class="tab active" onclick="showTab('orders')">Gestión Pedidos</div>
  <div id="tab-invoices" class="tab" onclick="showTab('invoices')">Libro de Facturas</div>
</div>

<main>
  <div id="view-orders">
    <div class="card row">
      <select id="status" onchange="loadOrders()">
        <option value="pending">Pendientes</option>
        <option value="license_sent">Enviadas</option>
      </select>
      <button class="btn" onclick="loadOrders()">Refrescar Pedidos</button>
    </div>
    <div class="card">
      <div class="scroll-area">
        <table id="table-orders">
          <thead><tr><th>Fecha</th><th>Método</th><th>Email</th><th>NIF/Empresa</th><th>Referencia</th><th>Acción</th></tr></thead>
          <tbody id="rows-orders"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="view-invoices" class="hidden">
    <div class="card row">
      <div class="filter-group">
        <span class="filter-label">Período:</span>
        <input type="date" id="date-start">
        <input type="date" id="date-end">
        <button class="btn-outline" style="padding: 5px 10px; font-size: 11px;" onclick="clearFilters()">Limpiar</button>
      </div>
      <div class="filter-group">
        <button class="btn-outline" onclick="setQuarter(1)">Q1</button>
        <button class="btn-outline" onclick="setQuarter(2)">Q2</button>
        <button class="btn-outline" onclick="setQuarter(3)">Q3</button>
        <button class="btn-outline" onclick="setQuarter(4)">Q4</button>
      </div>
      <button class="btn" onclick="loadInvoices()">Filtrar Libro</button>
      <button class="btn-csv" onclick="exportCSV()">Exportar CSV (Hacienda)</button>
    </div>

    <div class="card">
      <div class="scroll-area">
        <table id="table-invoices">
          <thead>
            <tr>
              <th>Factura</th>
              <th>Fecha</th>
              <th>NIF / Empresa</th>
              <th>Base (€)</th>
              <th>IVA (€)</th>
              <th>Ret (€)</th>
              <th>Total (€)</th>
              <th>Método</th>
            </tr>
          </thead>
          <tbody id="rows-invoices"></tbody>
          <tfoot id="foot-invoices"></tfoot>
        </table>
      </div>
    </div>
  </div>
</main>

<script>
  const KEY_LS = 'tuappgo_admin_key';
  document.getElementById('key').value = localStorage.getItem(KEY_LS) || '';

  function saveKey(){ 
    localStorage.setItem(KEY_LS, document.getElementById('key').value.trim()); 
  }

  function showTab(t){
    document.getElementById('view-orders').classList.toggle('hidden', t!=='orders');
    document.getElementById('view-invoices').classList.toggle('hidden', t!=='invoices');
    document.getElementById('tab-orders').classList.toggle('active', t==='orders');
    document.getElementById('tab-invoices').classList.toggle('active', t==='invoices');
    if(t==='invoices') {
        loadInvoices();
    }
  }

  function clearFilters() {
    document.getElementById('date-start').value = '';
    document.getElementById('date-end').value = '';
    loadInvoices();
  }

  function setQuarter(q) {
    const year = new Date().getFullYear();
    const quarters = {
      1: { s: '-01-01', e: '-03-31' },
      2: { s: '-04-01', e: '-06-30' },
      3: { s: '-07-01', e: '-09-30' },
      4: { s: '-10-01', e: '-12-31' }
    };
    document.getElementById('date-start').value = year + quarters[q].s;
    document.getElementById('date-end').value = year + quarters[q].e;
    loadInvoices();
  }

  async function api(path, opts={}){
    const key = (localStorage.getItem(KEY_LS) || '').trim();
    const headers = Object.assign({'x-admin-key': key}, opts.headers || {});
    const r = await fetch(path, Object.assign({}, opts, {headers}));
    
    const contentType = r.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Error en servidor. Verifica conexión.");
    }
    
    const j = await r.json();
    if(!r.ok) throw new Error(j.code || j.error || 'ERROR');
    return j;
  }

  async function loadOrders(){
    const rows = document.getElementById('rows-orders');
    rows.innerHTML = '<tr><td colspan="6">Cargando...</td></tr>';
    try {
      const j = await api('/api/admin/manual-orders?status=' + document.getElementById('status').value);
      if(!j.items || j.items.length === 0) {
        rows.innerHTML = '<tr><td colspan="6">No hay pedidos registrados.</td></tr>';
        return;
      }
      rows.innerHTML = j.items.map(o => \`<tr>
        <td>\${new Date(o.createdAt._seconds*1000).toLocaleString()}</td>
        <td>\${o.metodo || '—'}</td>
        <td>\${o.email}</td>
        <td>
          <div style="font-size:11px;">\${o.nifFactura || '—'}</div>
          <div style="font-weight:bold; font-size:10px;">\${o.nombreFactura || ''}</div>
        </td>
        <td>\${o.referencia || '—'}</td>
        <td>\${o.status==='pending' ? '<button class="btn2" onclick="complete(\\''+o.id+'\\')">Confirmar</button>':''}</td>
      </tr>\`).join('');
    } catch(e){ rows.innerHTML = '<tr><td colspan="6" style="color:red;">Error: '+e.message+'</td></tr>'; }
  }

  async function loadInvoices(){
    const rows = document.getElementById('rows-invoices');
    const foot = document.getElementById('foot-invoices');
    const start = document.getElementById('date-start').value;
    const end = document.getElementById('date-end').value;

    rows.innerHTML = '<tr><td colspan="8">Filtrando facturas...</td></tr>';
    
    let url = '/api/admin/invoices';
    if(start || end) {
      url += \`?startDate=\${start}&endDate=\${end}\`;
    }

    try {
      const j = await api(url);
      if(!j.items || j.items.length === 0) {
        rows.innerHTML = '<tr><td colspan="8">No hay facturas en este período.</td></tr>';
        foot.innerHTML = '';
        return;
      }
      let totals = {base:0, iva:0, ret:0, total:0};
      rows.innerHTML = j.items.map(i => {
        totals.base += i.base || 0;
        totals.iva += i.iva || 0;
        totals.ret += i.ret || 0;
        totals.total += i.total || 0;
        const fechaStr = i.date && i.date._seconds ? new Date(i.date._seconds*1000).toLocaleDateString() : '—';
        const isPro = i.tipoCliente === 'profesional';

        return \`<tr>
          <td>\${i.invoiceNumber || '—'}</td>
          <td>\${fechaStr}</td>
          <td>
            <div style="font-weight:bold;">\${i.nifFactura || 'Particular'}</div>
            <div style="font-size:10px; opacity:0.7;">\${i.nombreFactura || i.email || ''}</div>
          </td>
          <td>\${(i.base || 0).toFixed(2).replace('.', ',')}€</td>
          <td>\${(i.iva || 0).toFixed(2).replace('.', ',')}€</td>
          <td style="color:\${isPro ? '#f87171' : '#94a3b8'};">-\${(i.ret || 0).toFixed(2).replace('.', ',')}€</td>
          <td style="color:#22c55e; font-weight:bold;">\${(i.total || 0).toFixed(2).replace('.', ',')}€</td>
          <td><span class="pill \${isPro ? 'pill-pro' : ''}">\${i.method || 'manual'} \${isPro ? 'PRO' : ''}</span></td>
        </tr>\`;
      }).join('');

      foot.innerHTML = \`<tr>
        <td colspan="3">TOTALES DEL PERÍODO</td>
        <td>\${totals.base.toFixed(2).replace('.', ',')}€</td>
        <td>\${totals.iva.toFixed(2).replace('.', ',')}€</td>
        <td style="color:#f87171;">-\${totals.ret.toFixed(2).replace('.', ',')}€</td>
        <td style="color:#22c55e;">\${totals.total.toFixed(2).replace('.', ',')}€</td>
        <td></td>
      </tr>\`;
      window.lastInvoices = j.items;
    } catch(e){ rows.innerHTML = '<tr><td colspan="8" style="color:red;">Error: '+e.message+'</td></tr>'; }
  }

  async function complete(id){
    if(!confirm('¿Confirmar pago y emitir factura?')) return;
    try {
      await api('/api/admin/manual-orders/' + id + '/complete', {method:'POST'});
      loadOrders();
    } catch(e){ alert(e.message); }
  }

  function exportCSV(){
    if(!window.lastInvoices || window.lastInvoices.length === 0) { alert('No hay datos para exportar'); return; }
    
    let csv = "Factura;Fecha;NIF;Nombre/Empresa;Base;IVA;Retencion;Total;Metodo;Tipo\\n";
    
    window.lastInvoices.forEach(i => {
      const f = i.date && i.date._seconds ? new Date(i.date._seconds*1000).toLocaleDateString() : '';
      csv += \`\${i.invoiceNumber || ''};\${f};\${i.nifFactura || ''};\${i.nombreFactura || i.email || ''};\${(i.base || 0).toFixed(2)};\${(i.iva || 0).toFixed(2)};\${(i.ret || 0).toFixed(2)};\${(i.total || 0).toFixed(2)};\${i.method || ''};\${i.tipoCliente || ''}\\n\`;
    });
    
    const start = document.getElementById('date-start').value || 'inicio';
    const end = document.getElementById('date-end').value || 'fin';
    
    const blob = new Blob(["\\ufeff" + csv], {type:'text/csv;charset=utf-8;'});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = \`libro_facturas_tuappgo_\${start}_a_\${end}.csv\`;
    link.click();
  }

  loadOrders();
</script>
</body>
</html>`;
}

function adminPageHandler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(adminHtmlPage());
}

module.exports = { requireAdmin, listManualOrders, completeManualOrder, listInvoices, adminPageHandler };
