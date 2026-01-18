const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
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

function formatDateES(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function buildPurchaseEmail({ code, expiresAt, supportEmail }) {
  const expires = formatDateES(expiresAt);
  return {
    subject: 'Tu licencia de TuAppGo',
    text:
`Tuappgo te agradece tu confianza por tu compra.

Tu código de licencia:
${code}

Válida hasta: ${expires}

Cómo activar:
1) Abre la app
2) Ajustes -> Licencia
3) Pega el código y activa

Importante:
- La licencia es para 1 dispositivo.
- Incluye 1 cambio de dispositivo al año (gestionado por soporte).

Soporte: ${supportEmail}
`,
    html:
`<p>Tuappgo te agradece tu confianza por tu compra.</p>
<p><strong>Tu código de licencia:</strong><br>
<span style="font-size:18px;letter-spacing:1px;">${code}</span></p>
<p><strong>Válida hasta:</strong> ${expires}</p>
<p><strong>Cómo activar:</strong><br>
1) Abre la app<br>
2) Ajustes → Licencia<br>
3) Pega el código y activa</p>
<p><strong>Importante:</strong><br>
- La licencia es para 1 dispositivo.<br>
- Incluye 1 cambio de dispositivo al año (gestionado por soporte).</p>
<p><strong>Soporte:</strong> ${supportEmail}</p>`,
  };
}

function emailSignatureHtml() {
  return `
  <hr style="margin-top:30px; border:none; border-top:1px solid #e0e0e0;" />
  <div style="margin-top:20px; font-family:Arial, sans-serif; font-size:13px; color:#555;">
    <img
      src="https://tuappgo.com/contratos/assets/logo-tuappgo.png"
      alt="TuAppGo"
      style="height:100px; max-width:220px; margin-bottom:12px; display:block;"
    />
    <div style="margin-top:8px;">
      <strong>TuAppGo</strong><br />
      Automatización de contratos y documentos<br />
      <a href="https://tuappgo.com" style="color:#2a6edb; text-decoration:none;">
        https://tuappgo.com
      </a><br />
      <span style="color:#777;">contacto@tuappgo.com</span>
    </div>
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

async function listManualOrders(req, res) {
  try {
    const db = req.app?.locals?.db;
    if (!db) return res.status(503).json({ ok: false, code: 'FIRESTORE_NOT_READY' });

    const status = String(req.query?.status || 'pending');
    const q = db.collection('manual_orders')
  .where('status', '==', status)
  .limit(200);

const snap = await q.get();

let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

// Ordenamos aquí (sin forzar índice en Firestore)
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

    // transacción: validar estado y marcar como "paid_processing"
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
    if (!email || !email.includes('@')) {
      await orderRef.update({
        status: 'error',
        lastError: 'INVALID_EMAIL',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(400).json({ ok: false, code: 'INVALID_EMAIL' });
    }

    // crear licencia (source manual)
    const paidAtDate = new Date();
    const expiresAtDate = new Date(paidAtDate);
    expiresAtDate.setFullYear(expiresAtDate.getFullYear() + 1);

    const code = await generateUniqueLicenseCode(db, { collectionName: 'licenses' });

    const licRef = db.collection('licenses').doc(code);
    const paidAtTs = admin.firestore.Timestamp.fromDate(paidAtDate);
    const expiresAtTs = admin.firestore.Timestamp.fromDate(expiresAtDate);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(licRef);
      if (snap.exists) throw new Error('LICENSE_COLLISION');

      tx.create(licRef, {
        code,
        email,
        status: 'active',

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: paidAtTs,
        expiresAt: expiresAtTs,

        activatedUuid: null,
        activatedAt: null,

        deviceChangeUsed: false,
        deviceChangedAt: null,

        recoveryUsed: false,
        recoveryUsedAt: null,

        source: 'manual',
        manual: {
          orderId: id,
          metodo: order.metodo || null,
          referencia: order.referencia || null,
        },

        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: null,
      });
    });

    // enviar email (igual que Stripe)
    const transporter = buildTransporter();
    const supportEmail = process.env.SUPPORT_EMAIL || 'contacto@tuappgo.com';

    const mail = buildPurchaseEmail({ code, expiresAt: expiresAtDate, supportEmail });
    const finalHtml = `${mail.html}${emailSignatureHtml()}`;

    try {
      await transporter.sendMail({
        from: requireEnv('SMTP_FROM'),
        to: email,
        subject: mail.subject,
        text: mail.text,
        html: finalHtml,
      });
    } catch (mailErr) {
      // no rompemos el proceso, pero registramos error
      await orderRef.update({
        status: 'license_created_email_failed',
        licenseCode: code,
        emailError: String(mailErr.message || mailErr),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ ok: true, licenseCode: code, warning: 'EMAIL_FAILED' });
    }

    // cerrar pedido
    await orderRef.update({
      status: 'license_sent',
      licenseCode: code,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, licenseCode: code });
  } catch (err) {
    const msg = String(err?.message || err);

    // errores esperados
    if (msg === 'ORDER_NOT_FOUND') return res.status(404).json({ ok: false, code: 'ORDER_NOT_FOUND' });
    if (msg === 'ORDER_NOT_PENDING') return res.status(409).json({ ok: false, code: 'ORDER_NOT_PENDING' });

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
    .muted{opacity:.75}
    .pill{display:inline-block; padding:4px 8px; border-radius:999px; background:rgba(255,255,255,.10); font-size:12px;}
  </style>
</head>
<body>
<header><h1>TuAppGo Admin — Pagos manuales</h1></header>
<main>
  <div class="card">
    <div class="row">
      <input id="key" type="password" placeholder="ADMIN_KEY (se guarda en este navegador)" style="flex:1; min-width:240px;">
      <select id="status">
        <option value="pending">Pendientes</option>
        <option value="license_sent">Enviadas</option>
        <option value="paid_processing">Procesando</option>
        <option value="license_created_email_failed">Email falló</option>
        <option value="error">Error</option>
      </select>
      <button class="btn" onclick="saveKey()">Guardar clave</button>
      <button class="btn3" onclick="load()">Cargar</button>
    </div>
    <div class="muted" style="margin-top:8px;">
      El envío genera licencia y manda email desde <span class="mono">SMTP_FROM</span>. Precio actual: <span id="price" class="pill">—</span>
    </div>
  </div>

  <div class="card">
    <div id="msg" class="muted">—</div>
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
  const priceEl = document.getElementById('price');

  keyInput.value = localStorage.getItem(KEY_LS) || '';

  function saveKey(){
    localStorage.setItem(KEY_LS, keyInput.value.trim());
    msgEl.textContent = 'Clave guardada en este navegador.';
  }

  async function api(path, opts={}){
    const key = (localStorage.getItem(KEY_LS) || '').trim();
    const headers = Object.assign({'x-admin-key': key}, opts.headers || {});
    const r = await fetch(path, Object.assign({}, opts, {headers}));
    const j = await r.json().catch(()=>({ok:false, code:'BAD_JSON'}));
    if(!r.ok) throw new Error(j.code || ('HTTP_'+r.status));
    return j;
  }

  function esc(s){ return String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

  async function load(){
    rowsEl.innerHTML = '';
    msgEl.textContent = 'Cargando...';
    try{
      const st = statusSel.value;
      const j = await api('/api/admin/manual-orders?status=' + encodeURIComponent(st));
      priceEl.textContent = (j.priceEur ? (j.priceEur + ' €') : '—');
      const items = j.items || [];
      msgEl.textContent = 'Registros: ' + items.length;

      rowsEl.innerHTML = items.map(o => {
        const created = o.createdAt && o.createdAt._seconds ? new Date(o.createdAt._seconds*1000) : null;
        const dateTxt = created ? created.toLocaleString('es-ES') : '—';
        const actionBtn = (o.status === 'pending')
          ? '<button class="btn2" onclick="complete(\\''+esc(o.id)+'\\')">Marcar pagado + enviar licencia</button>'
          : '—';

        return '<tr>'
          + '<td>' + esc(dateTxt) + '</td>'
          + '<td><span class="pill">' + esc(o.metodo||'') + '</span></td>'
          + '<td>' + esc(o.email||'') + '</td>'
          + '<td class="mono">' + esc(o.referencia||'') + '</td>'
          + '<td>' + esc(o.status||'') + (o.licenseCode ? '<br><span class="mono">'+esc(o.licenseCode)+'</span>' : '') + '</td>'
          + '<td>' + actionBtn + '</td>'
          + '</tr>';
      }).join('');
    }catch(e){
      msgEl.textContent = 'Error: ' + e.message;
    }
  }

  async function complete(id){
    if(!confirm('¿Marcar como pagado y ENVIAR licencia?')) return;
    msgEl.textContent = 'Procesando ' + id + '...';
    try{
      const j = await api('/api/admin/manual-orders/' + encodeURIComponent(id) + '/complete', { method:'POST' });
      msgEl.textContent = 'OK. Licencia: ' + (j.licenseCode || '—');
      await load();
    }catch(e){
      msgEl.textContent = 'Error: ' + e.message;
    }
  }

  window.load = load;
  window.complete = complete;
  window.saveKey = saveKey;

  load();
</script>
</body>
</html>`;
}

function adminPageHandler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(adminHtmlPage());
}

module.exports = {
  requireAdmin,
  listManualOrders,
  completeManualOrder,
  adminPageHandler,
};
