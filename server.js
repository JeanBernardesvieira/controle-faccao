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
const DOWNLOAD_TIMEOUT = 30 * 1000; // 30 segundos de timeout por requisição

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

// ─── download XLSX com timeout ───────────────────────────────────────────────
function downloadBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;

    const timer = setTimeout(() => {
      reject(new Error('Timeout ao baixar planilha (30s)'));
    }, DOWNLOAD_TIMEOUT);

    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        clearTimeout(timer);
        return resolve(downloadBuffer(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      res.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    }).on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
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

    // Detectar o cabeçalho real: procurar a primeira linha que contenha MÊS/MES
    // (algumas abas como 2026 têm uma linha de totais antes do cabeçalho)
    let hdrRowIdx = 0;
    for (let ri = 0; ri < Math.min(rows.length, 5); ri++) {
      const candidate = rows[ri].map(h => safeStr(h).toUpperCase());
      if (candidate.some(h => h.startsWith('MÊS') || h === 'MES')) {
        hdrRowIdx = ri;
        break;
      }
    }
    const hdr = rows[hdrRowIdx].map(h => safeStr(h).toUpperCase());

    const iMes     = hdr.findIndex(h => h.startsWith('MÊS') || h === 'MES');
    const iAno     = hdr.findIndex(h => h === 'ANO');
    const iEmp     = hdr.findIndex(h => h.includes('EMPRESA'));
    const iRef     = hdr.findIndex(h => h.startsWith('REF'));
    const iMod     = hdr.findIndex(h => h.startsWith('MODEL'));
    const iVal     = hdr.findIndex((h,i) => i > Math.max(iMod,iRef) && (h === 'VALOR' || h.startsWith('VALOR')));
    const iQtd     = hdr.findIndex((h,i) => i > iVal && (h.includes('ENVIAD') || h === 'PECAS' || h.includes('QUANT') || h === 'FACCAO'));
    const iTotal   = hdr.findIndex((h,i) => i > (iQtd>0?iQtd:iVal) && h === 'TOTAL');
    const iPago    = hdr.findIndex(h => h.startsWith('PAGO') || h.startsWith('RECEBIDO'));

    for (let r = hdrRowIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row[iMes] == null) continue;
      const mes    = safeInt(row[iMes]);
      const ano    = fixYear(row[iAno]) || parseInt(name);
      const emp    = safeStr(row[iEmp]);
      const ref    = safeStr(row[iRef]);
      const modelo = safeStr(row[iMod]);
      const valor  = iVal >= 0 ? safeFloat(row[iVal]) : 0;
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
    // Detectar o cabeçalho de DESPESAS (linha com MÊS, ENTRADAS, ENERGIA...)
    let despHdrIdx = -1;
    let despHdr = [];
    for (let ri = 0; ri < Math.min(rows.length, 5); ri++) {
      const candidate = rows[ri].map(h => safeStr(h).toUpperCase());
      if (candidate.includes('ENTRADAS') || candidate.includes('ENERGIA')) {
        despHdrIdx = ri;
        despHdr = candidate;
        break;
      }
    }
    const iDEnt  = despHdr.findIndex(h => h === 'ENTRADAS');
    const iDEne  = despHdr.findIndex(h => h === 'ENERGIA');
    const iDAgua = despHdr.findIndex(h => h === 'AGUA' || h === 'ÁGUA');
    const iDInt  = despHdr.findIndex(h => h === 'INTERNET');
    const iDDiar = despHdr.findIndex(h => h === 'DIARISTAS' || h.startsWith('DIARI'));
    const iDMan  = despHdr.findIndex(h => h.startsWith('MANUT'));
    const iDMat  = despHdr.findIndex(h => h === 'MATERIAIS');
    const iDGuia = despHdr.findIndex(h => h.startsWith('GUIA'));
    const iDPro  = despHdr.findIndex(h => h.startsWith('PRO'));
    for (const row of rows) {
      if (!row || row[0] == null) continue;
      const nome = safeStr(row[0]).toUpperCase();
      if (!MESES_PT.includes(nome)) continue;
      const entradas = iDEnt  >= 0 ? safeFloat(row[iDEnt])  : safeFloat(row[1]);
      const energia  = iDEne  >= 0 ? safeFloat(row[iDEne])  : safeFloat(row[2]);
      const agua     = iDAgua >= 0 ? safeFloat(row[iDAgua]) : safeFloat(row[3]);
      const internet = iDInt  >= 0 ? safeFloat(row[iDInt])  : safeFloat(row[4]);
      const diaris   = iDDiar >= 0 ? safeFloat(row[iDDiar]) : safeFloat(row[5]);
      const manut    = iDMan  >= 0 ? safeFloat(row[iDMan])  : safeFloat(row[6]);
      const mats     = iDMat  >= 0 ? safeFloat(row[iDMat])  : safeFloat(row[7]);
      const guia     = iDGuia >= 0 ? safeFloat(row[iDGuia]) : safeFloat(row[8]);
      const prolabore= iDPro  >= 0 ? safeFloat(row[iDPro])  : safeFloat(row[9]);
      const totalD   = energia+agua+internet+diaris+manut+mats+guia+prolabore;
      // Evitar duplicatas: pular se já existe o mesmo mês
      if (!despesas.find(d => d.mes === nome)) {
        despesas.push({ mes: nome, entradas, energia, agua, internet, diaristas: diaris, manut, materiais: mats, guia, prolabore, total_despesas: totalD });
      }
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
  // Tentar 'LEVANTAMENTO 2025' primeiro (mais completo), depois 'LEVANTAMENTO'
  const levSheetName = wb.SheetNames.includes('LEVANTAMENTO 2025') ? 'LEVANTAMENTO 2025' : 'LEVANTAMENTO';
  if (wb.SheetNames.includes(levSheetName)) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[levSheetName], { header: 1, defval: null });
    // Detectar cabeçalho
    let levHdrIdx = 0;
    for (let ri = 0; ri < Math.min(rows.length, 3); ri++) {
      const candidate = rows[ri].map(h => safeStr(h).toUpperCase());
      if (candidate.some(h => h.includes('GANHO') || h === 'MESES')) {
        levHdrIdx = ri;
        break;
      }
    }
    const levHdr = rows[levHdrIdx].map(h => safeStr(h).toUpperCase());
    const iLGanhos = levHdr.findIndex(h => h.includes('GANHO'));
    const iLDiar   = levHdr.findIndex(h => h.includes('DIARI'));
    const iLDesp   = levHdr.findIndex(h => h.includes('DESP'));
    const iLLucFac = levHdr.findIndex(h => h.includes('FACÇ') || h.includes('FACCAO') || h.includes('LUCRO'));
    const iLPagFac = levHdr.findIndex((h,i) => i > iLLucFac && (h.includes('PAGO') || h.includes('FACÇÃO')));
    const iLLiq    = levHdr.findIndex((h,i) => i > iLPagFac && (h.includes('GANHO') || h.includes('LIQ') || h.includes('REAL')));
    for (let i = levHdrIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[0]) continue;
      const nome = safeStr(row[0]).toUpperCase();
      if (!MESES_PT.includes(nome)) continue;
      const ganhos = iLGanhos >= 0 ? safeFloat(row[iLGanhos]) : safeFloat(row[1]);
      if (ganhos > 0) {
        levantamento.push({
          mes: nome,
          ganhos,
          diarias_val: iLDiar   >= 0 ? safeFloat(row[iLDiar])   : safeFloat(row[2]),
          desp_fix:    iLDesp   >= 0 ? safeFloat(row[iLDesp])   : safeFloat(row[3]),
          lucro_fac:   iLLucFac >= 0 ? (row[iLLucFac] == null || row[iLLucFac] === '-' ? 0 : safeFloat(row[iLLucFac])) : 0,
          pago_fac:    iLPagFac >= 0 ? (row[iLPagFac] == null || row[iLPagFac] === '-' ? 0 : safeFloat(row[iLPagFac])) : 0,
          ganhos_liq:  iLLiq    >= 0 ? (row[iLLiq]    == null || row[iLLiq]    === '-' ? 0 : safeFloat(row[iLLiq]))    : 0
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
    if (cache) {
      console.log('[data] Usando cache anterior como fallback.');
      return cache;
    }
    // Retorna estrutura vazia para não travar o servidor
    console.warn('[data] Nenhum cache disponível. Retornando dados vazios.');
    return { sales: [], despesas: [], diarias: [], levantamento: [] };
  }
}

// ─── startup: sobe o servidor PRIMEIRO, depois carrega dados ─────────────────
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cached: !!cache, lastUpdated });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Sobe o servidor IMEDIATAMENTE — não espera o carregamento da planilha
app.listen(PORT, () => {
  console.log(`🚀 Dashboard rodando na porta ${PORT}`);
  // Carrega os dados em background após o servidor estar pronto
  loadData().catch(err => console.error('[startup] Erro ao carregar dados iniciais:', err.message));
});

// Refresh a cada 30 min
setInterval(() => loadData(true).catch(console.error), CACHE_TTL);
