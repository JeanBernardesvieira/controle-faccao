const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const SHEET_ID = '1thhOQxlobQZxKmt6aMFcqa-0CJB3_swU';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos

let cache = null;
let cacheTime = 0;
let lastUpdated = null;

// ─── helpers ────────────────────────────────────────────────────────────────
function safeFloat(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[R$\s]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function safeInt(v) { return Math.round(safeFloat(v)); }
function safeStr(v) { return v == null ? '' : String(v).trim(); }
function safeDate(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleDateString('pt-BR');
  return String(v);
}
function fixYear(y) {
  const n = safeInt(y);
  if (n === 0) return null;
  return n < 100 ? 2000 + n : n;
}

// ─── download XLSX ───────────────────────────────────────────────────────────
function downloadBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        return resolve(downloadBuffer(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── parse all sheets ────────────────────────────────────────────────────────
function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const sales = [];
  const despesas = [];
  const diarias = [];
  const levantamento = [];

  // ── SALES (2020-2026) ──────────────────────────────────────────────────────
  const salesSheets = ['2020','2021','2022','2023','2024','2025','2026'];
  for (const name of salesSheets) {
    if (!wb.SheetNames.includes(name)) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
    if (rows.length < 2) continue;
    const hdr = rows[0].map(h => safeStr(h).toUpperCase());

    // detect column positions dynamically
    const iMes     = hdr.findIndex(h => h.startsWith('MÊS') || h === 'MES');
    const iAno     = hdr.findIndex(h => h === 'ANO');
    const iEmp     = hdr.findIndex(h => h.includes('EMPRESA'));
    const iRef     = hdr.findIndex(h => h.startsWith('REF'));
    const iMod     = hdr.findIndex(h => h.startsWith('MODEL'));
    // valor: column index after REF/MODEL
    const iVal     = hdr.findIndex((h,i) => i > Math.max(iMod,iRef) && (h === 'VALOR' || h.startsWith('VALOR')));
    // qtd: ENVIADAS / PECAS / QUANTIDADE / FACCAO col comes after valor
    const iQtd     = hdr.findIndex((h,i) => i > iVal && (h.includes('ENVIAD') || h === 'PECAS' || h.includes('QUANT') || h === 'FACCAO'));
    // total
    const iTotal   = hdr.findIndex((h,i) => i > (iQtd>0?iQtd:iVal) && h === 'TOTAL');
    // pago
    const iPago    = hdr.findIndex(h => h.startsWith('PAGO') || h.startsWith('RECEBIDO'));

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row[iMes] == null) continue;
      const mes    = safeInt(row[iMes]);
      const ano    = fixYear(row[iAno]) || parseInt(name);
      const emp    = safeStr(row[iEmp]);
      const ref    = safeStr(row[iRef]);
      const modelo = safeStr(row[iMod]);
      const valor  = iVal >= 0 ? safeFloat(row[iVal]) : 0;
      // for 2025/2026 qtd is QUANTIDADE col, not FACCAO
      let qtd = 0;
      if (['2025','2026'].includes(name)) {
        const iQ2 = hdr.findIndex((h,i) => i > iVal && h.includes('QUANT'));
        qtd = iQ2 >= 0 ? safeInt(row[iQ2]) : (iQtd >= 0 ? safeInt(row[iQtd]) : 0);
      } else {
        qtd = iQtd >= 0 ? safeInt(row[iQtd]) : 0;
      }
      const total  = iTotal >= 0 ? safeFloat(row[iTotal]) : 0;
      const pago   = iPago >= 0 ? safeDate(row[iPago]) : '';
      if (mes > 0 && mes <= 12 && emp && modelo && total > 0) {
        sales.push({ mes, ano, empresa: emp, ref, modelo, valor, qtd, total, pago });
      }
    }
  }

  // ── DESPESAS ──────────────────────────────────────────────────────────────
  const MESES_PT = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
  if (wb.SheetNames.includes('DESPESAS')) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['DESPESAS'], { header: 1, defval: null });
    for (const row of rows) {
      if (!row || row[0] == null) continue;
      const nome = safeStr(row[0]).toUpperCase();
      if (!MESES_PT.includes(nome)) continue;
      const entradas = safeFloat(row[1]);
      const energia  = safeFloat(row[2]);
      const agua     = safeFloat(row[3]);
      const internet = safeFloat(row[4]);
      const diaris   = safeFloat(row[5]);
      const manut    = safeFloat(row[6]);
      const mats     = safeFloat(row[7]);
      const guia     = safeFloat(row[8]);
      const prolabore= safeFloat(row[9]);
      const totalD   = energia+agua+internet+diaris+manut+mats+guia+prolabore;
      despesas.push({ mes: nome, entradas, energia, agua, internet, diaristas: diaris, manut, materiais: mats, guia, prolabore, total_despesas: totalD });
    }
  }

  // ── DIÁRIAS MENSAL ────────────────────────────────────────────────────────
  const dName = wb.SheetNames.find(n => n.toUpperCase().startsWith('DIARIAS MENSAL'));
  if (dName) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[dName], { header: 1, defval: null });
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[0]) continue;
      const nome = safeStr(row[0]).toUpperCase();
      if (!MESES_PT.includes(nome)) continue;
      const dias = safeInt(row[1]);
      if (dias > 0) {
        diarias.push({
          mes: nome, dias,
          s1: safeInt(row[2]), s2: safeInt(row[3]),
          s3: safeInt(row[4]), s4: safeInt(row[5]),
          s5: safeInt(row[6]), total: safeFloat(row[7])
        });
      }
    }
  }

  // ── LEVANTAMENTO ─────────────────────────────────────────────────────────
  if (wb.SheetNames.includes('LEVANTAMENTO')) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['LEVANTAMENTO'], { header: 1, defval: null });
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[0]) continue;
      const nome = safeStr(row[0]).toUpperCase();
      if (!MESES_PT.includes(nome)) continue;
      const ganhos = safeFloat(row[1]);
      if (ganhos > 0) {
        levantamento.push({
          mes: nome,
          ganhos,
          diarias_val: safeFloat(row[2]),
          desp_fix:    safeFloat(row[3]),
          lucro_fac:   (row[4] == null || row[4] === '-') ? 0 : safeFloat(row[4]),
          pago_fac:    (row[5] == null || row[5] === '-') ? 0 : safeFloat(row[5]),
          ganhos_liq:  (row[6] == null || row[6] === '-') ? 0 : safeFloat(row[6])
        });
      }
    }
  }

  return { sales, despesas, diarias, levantamento };
}

// ─── load & cache ────────────────────────────────────────────────────────────
async function loadData(force = false) {
  const now = Date.now();
  if (!force && cache && (now - cacheTime) < CACHE_TTL) return cache;

  console.log('[data] Baixando planilha do Google Sheets...');
  try {
    const buf = await downloadBuffer(SHEET_URL);
    const parsed = parseWorkbook(buf);
    cache = parsed;
    cacheTime = now;
    lastUpdated = new Date().toLocaleString('pt-BR');
    console.log(`[data] OK — ${parsed.sales.length} registros de vendas | ${new Date().toLocaleTimeString()}`);
    return cache;
  } catch (err) {
    console.error('[data] Erro ao baixar planilha:', err.message);
    if (cache) return cache; // return stale cache on error
    throw err;
  }
}

// pre-load on startup
loadData().catch(console.error);
// refresh every 30 min
setInterval(() => loadData(true).catch(console.error), CACHE_TTL);

// ─── routes ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const data = await loadData();
    res.json({ ...data, lastUpdated, cacheAge: Math.round((Date.now() - cacheTime) / 1000) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    await loadData(true);
    res.json({ ok: true, lastUpdated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Dashboard rodando na porta ${PORT}`));
