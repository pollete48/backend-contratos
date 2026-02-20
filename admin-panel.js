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
  return `
    <div style="margin-top:30px; border:1px solid #ddd; padding:20px; font-family:Arial, sans-serif; border-radius:8px; color:#333; max-width: 550px;">
      <table style="width:100%;">
        <tr>
          <td style="vertical-align:top;"><img src="https://tuappgo.com/contratos/assets/logo-tuappgo.png" alt="TuAppGo" style="height:105px;"></td>
          <td style="text-align:right; font-size:12px; color:#555;">
            <strong>EMISOR:</strong><br>${emisor.nombre}<br>${emisor.dni}<br>${emisor.dir}<br>${emisor.tel}
          </td>
        </tr>
      </table>
      <div style="margin-top:20px;">
        <h3 style="margin-bottom:5px; color:#1a1a1a;">FACTURA: ${invoiceData.numero}</h3>
        <p style="font-size:13px; margin-top:0;">Fecha: ${invoiceData.fecha}</p>
      </div>
      <table style="width:100%; border-collapse:collapse; margin-top:15px; font-size:15px;">
        <tr><td style="padding:10px 0; border-bottom:1px solid #eee;">Base Imponible</td><td style="padding:10px 0; border-bottom:1px solid #eee; text-align:right;">${invoiceData.base}€</td></tr>
        <tr><td style="padding:10px 0; border-bottom:1px solid #eee;">IVA (${invoiceData.ivaPerc}%)</td><td style="padding:10px 0; border-bottom:1px solid #eee; text-align:right;">${invoiceData.iva}€</td></tr>
        <tr><td style="padding:10px 0; border-bottom:1px solid #eee;">Retención IRPF (-${invoiceData.retPerc}%)</td><td style="padding:10px 0; border-bottom:1px solid #eee; text-align:right; color:#d9534f;">-${invoiceData.ret}€</td></tr>
        <tr style="font-weight:bold;"><td style="padding:15px 0; font-size:1.1em;">TOTAL PAGADO</td><td style="padding:15px 0; text-align:right; font-size:1.1em; color:#28a745;">${invoiceData.total}€</td></tr>
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
        <p>Gracias por tu confianza.</p>
        <p><strong>Código de licencia:</strong><br><span style="font-size:18px; color:#2a6edb;">${code}</span></p>
        <p>Válida hasta: ${invoiceData.fecha}</p>
        ${facturaHtml}
      </div>
    `,
    facturaSoloHtml: `<html><body>${facturaHtml}</body></html>`
  };
}

function requireAdmin(req, res, next) {
  const key = String(req.headers['x-admin-key'] || '').trim();
  const expected = String(process.env.ADMIN_KEY || '').trim();
  if (!expected || key !== expected) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
  next();
}

function getPriceEur() {
  return Number(process.env.PRICE_EUR || 0);
}

function getBaseImponible() {
  return Number(process.env.PRECIO_BASE || 130.00);
}

// SUPER-FUNCIÓN: RECUPERA TODO DE GOLPE
async function getDashboardData(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(503).json({ ok: false, code: 'DB_ERROR' });

    const status = String(req.query?.status || 'pending');
    
    // Ejecutamos ambas consultas en paralelo para máxima velocidad
    const [ordersSnap, invoicesSnap] = await Promise.all([
      db.collection('manual_orders').where('status', '==', status).limit(100).get(),
      db.collection('invoices').orderBy('date', 'desc').limit(300).get()
    ]);

    const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    orders.sort((a, b) => (b?.createdAt?._seconds ?? 0) - (a?.createdAt?._seconds ?? 0));
    
    const invoices = invoicesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({ ok: true, orders, invoices, priceEur: getPriceEur() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function completeManualOrder(req, res) {
  try {
    const db = req.app?.locals?.db;
    const id = String(req.params?.id || '').trim();
    const orderRef = db.collection('manual_orders').doc(id);
    const order = await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists) throw new Error('NOT_FOUND');
      const o = snap.data();
      tx.update(orderRef, { status: 'paid_processing', paidAt: admin.firestore.FieldValue.serverTimestamp() });
      return { id: snap.id, ...o };
    });

    const email = String(order.email || '').trim().toLowerCase();
    const code = await generateUniqueLicenseCode(db, { collectionName: 'licenses' });
    const numFactura = await getNextInvoiceNumber(db);
    
    const ivaPerc = parseFloat(process.env.IVA_PORCENTAJE || '21');
    const retPerc = parseFloat(process.env.RETENCION_PORCENTAJE || '7');
    const totalVal = getPriceEur();
    const baseVal = getBaseImponible();
    const ivaVal = parseFloat((baseVal * (ivaPerc / 100)).toFixed(2));
    const retVal = parseFloat((baseVal * (retPerc / 100)).toFixed(2));

    const invoiceData = {
      numero: numFactura, fecha: new Date().toLocaleDateString('es-ES'),
      base: baseVal.toFixed(2).replace('.', ','), iva: ivaVal.toFixed(2).replace('.', ','),
      ret: retVal.toFixed(2).replace('.', ','), total: totalVal.toFixed(2).replace('.', ','),
      ivaPerc, retPerc
    };

    await db.collection('invoices').doc(numFactura.replace('/', '-')).set({
      invoiceNumber: numFactura, date: admin.firestore.FieldValue.serverTimestamp(),
      email, base: baseVal, iva: ivaVal, ret: retVal, total: totalVal, method: order.metodo || 'manual'
    });

    const mail = buildPurchaseEmail({ code, invoiceData });
    const pdfBuffer = await htmlPdf.generatePdf({ content: mail.facturaSoloHtml }, { format: 'A4' });
    const transporter = buildTransporter();
    
    await transporter.sendMail({
      from: requireEnv('SMTP_FROM'), to: email, subject: mail.subject,
      html: mail.html,
      attachments: [{ filename: `Factura_${numFactura.replace('/', '-')}.pdf`, content: pdfBuffer }]
    });

    await orderRef.update({ status: 'license_sent', licenseCode: code, invoice: numFactura });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

function adminHtmlPage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>TuAppGo Admin</title>
  <style>
    body{font-family:system-ui,-apple-system,Arial; margin:0; background:#0b1220; color:#e8eefc; overflow-x:hidden;}
    header{padding:18px 20px; background:#0f1b33; border-bottom:1px solid rgba(255,255,255,.08); display:flex; justify-content:space-between; align-items:center; position:sticky; top:0; z-index:100;}
    .nav-tabs{display:flex; gap:10px; margin: 20px 18px 10px 18px;}
    .tab{padding:12px 24px; cursor:pointer; border-radius:12px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); transition:0.2s;}
    .tab.active{background:#2a6edb; border-color:#2a6edb; box-shadow:0 4px 12px rgba(42,110,219,0.3);}
    main{max-width:1100px; margin:0 auto; padding:18px; min-height:80vh;}
    .card{background:#0f1b33; border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:18px; margin-bottom:15px;}
    .row{display:flex; gap:12px; flex-wrap:wrap; align-items:center;}
    input,select{background:#0b1220; color:#e8eefc; border:1px solid rgba(255,255,255,.14); border-radius:10px; padding:10px 14px;}
    button{border:0; border-radius:12px; padding:10px 16px; cursor:pointer; font-weight:700; transition:0.2s;}
    button:active{transform:scale(0.96);}
    .btn{background:#2a6edb; color:white;}
    .btn2{background:#22c55e; color:#07121e;}
    .btn-csv{background:#f59e0b; color:#07121e;}
    .scroll-container{overflow-x:auto; width:100%; border-radius:8px;}
    table{width:100%; border-collapse:collapse; min-width:600px;}
    th,td{padding:14px; border-bottom:1px solid rgba(255,255,255,.06); font-size:14px; text-align:left;}
    th{background:rgba(255,255,255,.03); color:#94a3b8; font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.5px;}
    tfoot{font-weight:bold; background:rgba(255,255,255,.04); color:#fff;}
    .hidden{display:none;}
    .pill{padding:4px 8px; border-radius:6px; background:rgba(255,255,255,.1); font-size:11px;}
  </style>
</head>
<body>
<header>
  <h2 style="margin:0; font-size:18px;">TuAppGo Admin</h2>
  <div><input id="key" type="password" placeholder="ADMIN_KEY" style="width:120px;" onchange="saveKey()"></div>
</header>

<div class="nav-tabs">
  <div id="tab-orders" class="tab active" onclick="showTab('orders')">Gestión Pedidos</div>
  <div id="tab-invoices" class="tab" onclick="showTab('invoices')">Libro de Facturas</div>
</div>

<main>
  <div id="view-orders">
    <div class="card row">
      <select id="status" onchange="loadDashboard()">
        <option value="pending">Pendientes</option>
        <option value="license_sent">Enviadas</option>
      </select>
      <button class="btn" onclick="loadDashboard()">Refrescar Todo</button>
    </div>
    <div class="card">
      <div class="scroll-container">
        <table>
          <thead><tr><th>Fecha</th><th>Método</th><th>Email</th><th>Referencia</th><th>Acción</th></tr></thead>
          <tbody id="rows-orders"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="view-invoices" class="hidden">
    <div class="card row">
      <button class="btn" onclick="loadDashboard()">Actualizar Datos</button>
      <button class="btn-csv" onclick="exportCSV()">Exportar Libro (CSV)</button>
    </div>
    <div class="card">
      <div class="scroll-container">
        <table>
          <thead>
            <tr><th>Factura</th><th>Fecha</th><th>Email</th><th>Base (€)</th><th>IVA (€)</th><th>Ret (€)</th><th>Total (€)</th><th>Método</th></tr>
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
  let globalInvoices = [];

  function saveKey(){ localStorage.setItem(KEY_LS, document.getElementById('key').value.trim()); }

  function showTab(t){
    document.getElementById('view-orders').classList.toggle('hidden', t!=='orders');
    document.getElementById('view-invoices').classList.toggle('hidden', t!=='invoices');
    document.getElementById('tab-orders').classList.toggle('active', t==='orders');
    document.getElementById('tab-invoices').classList.toggle('active', t==='invoices');
  }

  async function api(path, opts={}){
    const key = (localStorage.getItem(KEY_LS) || '').trim();
    const r = await fetch(path, { ...opts, headers: { ...opts.headers, 'x-admin-key': key } });
    const j = await r.json();
    if(!r.ok) throw new Error(j.code || j.error || 'ERROR');
    return j;
  }

  async function loadDashboard(){
    const rowsOrders = document.getElementById('rows-orders');
    const rowsInvoices = document.getElementById('rows-invoices');
    const footInvoices = document.getElementById('foot-invoices');
    
    rowsOrders.innerHTML = '<tr><td colspan="5">Cargando...</td></tr>';
    rowsInvoices.innerHTML = '<tr><td colspan="8">Cargando...</td></tr>';

    try {
      const j = await api('/api/admin/dashboard?status=' + document.getElementById('status').value);
      
      // PEDIDOS
      rowsOrders.innerHTML = j.orders.length ? j.orders.map(o => \`<tr>
        <td>\${new Date(o.createdAt._seconds*1000).toLocaleString()}</td>
        <td>\${o.metodo || '—'}</td><td>\${o.email}</td><td>\${o.referencia || '—'}</td>
        <td>\${o.status==='pending' ? '<button class="btn2" onclick="complete(\\''+o.id+'\\')">Confirmar</button>':''}</td>
      </tr>\`).join('') : '<tr><td colspan="5">Vacio</td></tr>';

      // FACTURAS
      globalInvoices = j.invoices || [];
      if(!globalInvoices.length) {
        rowsInvoices.innerHTML = '<tr><td colspan="8">Sin facturas</td></tr>';
        footInvoices.innerHTML = '';
      } else {
        let totals = {base:0, iva:0, ret:0, total:0};
        rowsInvoices.innerHTML = globalInvoices.map(i => {
          totals.base += i.base || 0; totals.iva += i.iva || 0; 
          totals.ret += i.ret || 0; totals.total += i.total || 0;
          const fecha = i.date?._seconds ? new Date(i.date._seconds*1000).toLocaleDateString() : '—';
          return \`<tr>
            <td>\${i.invoiceNumber || '—'}</td><td>\${fecha}</td><td>\${i.email || '—'}</td>
            <td>\${(i.base || 0).toFixed(2).replace('.',',')}</td><td>\${(i.iva || 0).toFixed(2).replace('.',',')}</td>
            <td>-\${(i.ret || 0).toFixed(2).replace('.',',')}</td>
            <td style="color:#22c55e; font-weight:bold;">\${(i.total || 0).toFixed(2).replace('.',',')}</td>
            <td><span class="pill">\${i.method || 'manual'}</span></td>
          </tr>\`;
        }).join('');

        footInvoices.innerHTML = \`<tr><td colspan="3">TOTALES</td>
          <td>\${totals.base.toFixed(2).replace('.',',')}€</td><td>\${totals.iva.toFixed(2).replace('.',',')}€</td>
          <td>-\${totals.ret.toFixed(2).replace('.',',')}€</td><td style="color:#22c55e;">\${totals.total.toFixed(2).replace('.',',')}€</td><td></td></tr>\`;
      }
    } catch(e){ alert('Error: ' + e.message); }
  }

  async function complete(id){
    if(!confirm('¿Confirmar y enviar factura?')) return;
    try { await api('/api/admin/manual-orders/' + id + '/complete', {method:'POST'}); loadDashboard(); } 
    catch(e){ alert(e.message); }
  }

  function exportCSV(){
    if(!globalInvoices.length) return;
    let csv = "Factura;Fecha;Email;Base;IVA;Retencion;Total;Metodo\\n";
    globalInvoices.forEach(i => {
      const f = i.date?._seconds ? new Date(i.date._seconds*1000).toLocaleDateString() : '';
      csv += \`\${i.invoiceNumber};\${f};\${i.email};\${i.base};\${i.iva};\${i.ret};\${i.total};\${i.method}\\n\`;
    });
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "libro_facturas_tuappgo.csv";
    link.click();
  }

  loadDashboard();
</script>
</body></html>`;
}

function adminPageHandler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(adminHtmlPage());
}

module.exports = { requireAdmin, getDashboardData, completeManualOrder, adminPageHandler };
