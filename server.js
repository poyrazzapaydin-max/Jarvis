// ============================================================
// JARVIS - Backend-Server
// Übernimmt drei Aufgaben, damit keine Secret-Keys im Frontend-
// Code landen:
//  1) Liefert die statische Frontend-App aus (index.html etc.)
//  2) Kapselt die Gemini-API (Key bleibt serverseitig)
//  3) Kapselt die MEXC-Futures-API inkl. HMAC-Signierung (Secret
//     bleibt serverseitig)
// Zusätzlich: TTS über edge-tts + ein Allzweck-Proxy für News (GDELT).
//
// Alle Keys werden über Umgebungsvariablen (process.env) gelesen,
// NICHT aus einer Datei im Repo. Lokal: lege eine ".env"-Datei an
// (siehe .env.example). Auf Render.com: im Dashboard unter
// "Environment" eintragen.
// ============================================================

try { require('dotenv').config(); } catch (err) { /* dotenv optional, z.B. auf Render nicht nötig */ }

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- Konfiguration aus Umgebungsvariablen ----
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const MEXC_API_KEY = process.env.MEXC_API_KEY || '';
const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// ---- Postgres-Verbindung (für Auto-Trader / Paper-Trading-Daten) ----
// Render-Postgres verlangt SSL, erlaubt aber kein eigenes Zertifikat -
// daher rejectUnauthorized:false (Standardpraxis für Render/Heroku-Postgres).
const pgPool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ============================================================
// Frontend ausliefern (index.html, config.js entfällt komplett)
// ============================================================
app.use(express.static(path.join(__dirname)));

// ============================================================
// Konfigurations-Status (NIE die echten Keys zurückgeben - nur ob
// sie gesetzt sind. Das Frontend nutzt das für UI-Zustände.)
// ============================================================
app.get('/api/config/status', (req, res) => {
  res.json({
    geminiConfigured: !!GEMINI_API_KEY,
    geminiModel: GEMINI_MODEL,
    mexcConfigured: !!(MEXC_API_KEY && MEXC_API_SECRET)
  });
});

// Schlanker, direkter Gemini-Aufruf für Server-interne Zwecke (Auto-Trader-
// Gegencheck und Selbstauswertung). Gibt bei fehlendem Key null zurück,
// statt zu werfen - Aufrufer müssen den Fallback selbst handhaben.
async function callGeminiText(prompt) {
  if (!GEMINI_API_KEY) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
    });
    if (!upstream.ok) {
      console.error('Auto Trader: Gemini-Aufruf fehlgeschlagen, HTTP', upstream.status);
      return null;
    }
    const data = await upstream.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    return text || null;
  } catch (err) {
    console.error('Auto Trader: Gemini-Aufruf-Fehler:', err.message || err);
    return null;
  }
}

// ============================================================
// Gemini-Proxy - der Browser schickt nur { contents, systemInstruction },
// der Key wird hier serverseitig angehängt und nie an den Client gesendet.
// ============================================================
app.post('/api/gemini/generate', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(400).json({ error: { message: 'Gemini ist serverseitig nicht konfiguriert (GEMINI_API_KEY fehlt).' } });
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    console.error('Gemini-Proxy-Fehler:', err);
    res.status(500).json({ error: { message: err.message || 'Gemini-Proxy-Fehler.' } });
  }
});

// ============================================================
// MEXC-Futures-Proxy (signiert serverseitig, Secret bleibt hier)
// Das Frontend schickt nur { path, params }, z.B.
// { path: "/api/v1/private/account/assets", params: {} }
// ============================================================
app.post('/api/mexc/signed', async (req, res) => {
  if (!MEXC_API_KEY || !MEXC_API_SECRET) {
    return res.status(400).json({ error: 'MEXC ist serverseitig nicht konfiguriert (MEXC_API_KEY/MEXC_API_SECRET fehlen).' });
  }
  const { path: mexcPath, params } = req.body || {};
  if (!mexcPath || !mexcPath.startsWith('/api/v1/private/')) {
    return res.status(400).json({ error: 'Ungültiger oder nicht erlaubter Pfad.' });
  }

  try {
    const timestamp = String(Date.now());
    const safeParams = params || {};
    const sortedKeys = Object.keys(safeParams).sort();
    const requestParamString = sortedKeys.map(k => `${k}=${safeParams[k]}`).join('&');
    const signTarget = MEXC_API_KEY + timestamp + requestParamString;
    const signature = crypto.createHmac('sha256', MEXC_API_SECRET).update(signTarget).digest('hex');

    const url = `https://contract.mexc.com${mexcPath}${requestParamString ? '?' + requestParamString : ''}`;
    const upstream = await fetch(url, {
      headers: {
        'ApiKey': MEXC_API_KEY,
        'Request-Time': timestamp,
        'Signature': signature,
        'Content-Type': 'application/json'
      }
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    console.error('MEXC-Proxy-Fehler:', err);
    res.status(500).json({ error: err.message || 'MEXC-Proxy-Fehler.' });
  }
});

// ============================================================
// Sprachausgabe über edge-tts (msedge-tts) - kein Key nötig.
// Ruhige, männliche deutsche Stimme als Standard.
// ============================================================
const DEFAULT_VOICE = 'de-DE-ConradNeural';
const ALLOWED_VOICES = new Set([
  'de-DE-ConradNeural',
  'de-DE-KillianNeural',
  'de-DE-FlorianMultilingualNeural'
]);

app.post('/api/tts', async (req, res) => {
  const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
  const requestedVoice = req.body && req.body.voice ? String(req.body.voice) : '';
  const voice = ALLOWED_VOICES.has(requestedVoice) ? requestedVoice : DEFAULT_VOICE;

  if (!text) {
    return res.status(400).json({ error: 'Kein Text übergeben.' });
  }

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);

    res.setHeader('Content-Type', 'audio/mpeg');
    audioStream.pipe(res);
    audioStream.on('error', (err) => {
      console.error('TTS-Stream-Fehler:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Fehler bei der Sprachsynthese.' });
    });
  } catch (err) {
    console.error('TTS-Fehler:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Fehler bei der Sprachsynthese.' });
  }
});

app.get('/api/tts/health', (req, res) => {
  res.json({ ok: true, defaultVoice: DEFAULT_VOICE, allowedVoices: [...ALLOWED_VOICES] });
});

// ============================================================
// Allzweck-Proxy (nur lesend, feste Host-Allowlist)
// Manche APIs setzen keine CORS-Header, ein Browser blockiert
// direkte Anfragen dorthin dann mit "Failed to fetch". Node
// unterliegt dieser Browser-Beschränkung nicht.
// - GDELT: News-Suche für die News-Seite (kein Key nötig)
// ============================================================
const PROXY_ALLOWED_HOSTS = new Set(['api.gdeltproject.org']);

app.post('/api/mexc-proxy', async (req, res) => {
  try {
    const { url, headers } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Keine URL übergeben.' });

    const target = new URL(url);
    if (!PROXY_ALLOWED_HOSTS.has(target.hostname)) {
      return res.status(400).json({ error: 'Nicht erlaubter Host.' });
    }

    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: headers || {}
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    console.error('Proxy-Fehler:', err);
    res.status(500).json({ error: err.message || 'Proxy-Fehler.' });
  }
});

// ============================================================
// AUTO TRADER - Paper Trading (reine Simulation)
//
// SICHERHEIT: Dieser gesamte Block liest NUR öffentliche Binance-
// Kursdaten (keine Authentifizierung, kein MEXC-Zugriff) und
// verändert ausschließlich lokal gespeicherte, simulierte Werte.
// Es gibt hier KEINEN Codepfad, der eine echte Order auf MEXC oder
// einer anderen Börse auslösen könnte. NICHT AUTOMATISCH AUSFÜHREN
// - NUR SIMULATION. Falls das jemals in echten Handel überführt
// werden soll, müsste an dieser Stelle bewusst und separat ein
// echter, signierter Order-Endpoint ergänzt werden - das ist NICHT
// Teil dieses Codes.
// ============================================================
const PAPER_DEFAULT_SETTINGS = {
  enabled: false,
  riskPerTradeEur: 0.5,
  riskRewardRatio: 2,
  watchedSymbols: [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'TAOUSDT', 'ZECUSDT', 'TRXUSDT', 'SHIBUSDT',
    'LTCUSDT', 'BCHUSDT', 'NEARUSDT', 'UNIUSDT', 'APTUSDT',
    'ICPUSDT', 'ETCUSDT', 'ATOMUSDT', 'FILUSDT', 'ARBUSDT',
    'OPUSDT', 'SUIUSDT', 'INJUSDT', 'RENDERUSDT', 'HBARUSDT',
    'VETUSDT', 'ALGOUSDT', 'SEIUSDT', 'AAVEUSDT'
  ],
  startCapitalEur: 100,
  maxOpenPositions: 3,
  leverage: 5,
  criteriaTrendEnabled: true,
  criteriaVolumeEnabled: false,
  criteriaMtfEnabled: false
};

// In-Memory-Cache nur für zuletzt gesehene Live-Preise (rein informativ
// für "unrealized P/L" in der UI, keine persistenten Daten, muss nicht
// in der DB liegen).
const paperLastPrices = {};

// Legt die Tabellen an, falls sie noch nicht existieren, und sorgt für
// genau eine Einstellungs-Zeile (Singleton, id=1).
async function initPaperTradingSchema() {
  if (!pgPool) {
    console.warn('Paper-Trading: DATABASE_URL nicht gesetzt - Auto Trader ist deaktiviert.');
    return;
  }
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      risk_per_trade_eur NUMERIC NOT NULL DEFAULT 0.5,
      risk_reward_ratio NUMERIC NOT NULL DEFAULT 2,
      watched_symbols TEXT[] NOT NULL DEFAULT ARRAY['BTCUSDT','ETHUSDT','SOLUSDT'],
      start_capital_eur NUMERIC NOT NULL DEFAULT 100,
      balance_eur NUMERIC NOT NULL DEFAULT 100,
      max_open_positions INTEGER NOT NULL DEFAULT 3,
      leverage INTEGER NOT NULL DEFAULT 5,
      last_check TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      stop_loss NUMERIC NOT NULL,
      take_profit NUMERIC NOT NULL,
      position_size_eur NUMERIC NOT NULL,
      risk_eur NUMERIC NOT NULL,
      leverage INTEGER NOT NULL DEFAULT 1,
      margin_eur NUMERIC NOT NULL DEFAULT 0,
      liquidation_price NUMERIC,
      liquidates_first BOOLEAN NOT NULL DEFAULT false,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL,
      exit_price NUMERIC,
      close_reason TEXT,
      pnl_eur NUMERIC,
      closed_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_balance_history (
      id SERIAL PRIMARY KEY,
      time TIMESTAMPTZ NOT NULL DEFAULT now(),
      balance NUMERIC NOT NULL
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_skipped_setups (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      reason TEXT,
      criteria_trend BOOLEAN NOT NULL DEFAULT false,
      criteria_volume BOOLEAN NOT NULL DEFAULT false,
      criteria_mtf BOOLEAN NOT NULL DEFAULT false,
      gemini_reasoning TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_insights (
      id INTEGER PRIMARY KEY DEFAULT 1,
      trade_count INTEGER NOT NULL DEFAULT 0,
      insight_text TEXT,
      generated_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_check_log (
      symbol TEXT PRIMARY KEY,
      sweep_bos_found BOOLEAN NOT NULL DEFAULT false,
      direction TEXT,
      failed_criteria TEXT,
      note TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migration für Spalten, die nachträglich (nach dem ersten Deploy) hinzukamen -
  // "CREATE TABLE IF NOT EXISTS" ergänzt bei bereits existierenden Tabellen
  // KEINE neuen Spalten, daher hier explizit per ALTER nachziehen. Idempotent,
  // läuft bei jedem Start.
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS max_open_positions INTEGER NOT NULL DEFAULT 3');
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS leverage INTEGER NOT NULL DEFAULT 5');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS leverage INTEGER NOT NULL DEFAULT 1');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS margin_eur NUMERIC NOT NULL DEFAULT 0');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS liquidation_price NUMERIC');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS liquidates_first BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS criteria_trend BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS criteria_volume BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS criteria_mtf BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS gemini_reasoning TEXT');
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS criteria_trend_enabled BOOLEAN NOT NULL DEFAULT true');
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS criteria_volume_enabled BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS criteria_mtf_enabled BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS flagged_buggy BOOLEAN NOT NULL DEFAULT false');

  // Einmalige Kennzeichnung des bekannten Bugs (unbegrenzte Margin bei sehr
  // engem SL-Abstand, z.B. der ATOM-Trade mit 9.452€ Margin bei 100€
  // Start-Kapital) - identifiziert per Heuristik (Margin deutlich über jedem
  // realistischen Wert), rein informativ, ändert die Trade-Daten nicht.
  await pgPool.query(
    "UPDATE paper_trades SET flagged_buggy = true WHERE margin_eur > 1000 AND flagged_buggy = false"
  );

  const { rows } = await pgPool.query('SELECT id FROM paper_settings WHERE id = 1');
  if (!rows.length) {
    await pgPool.query(
      `INSERT INTO paper_settings (id, enabled, risk_per_trade_eur, risk_reward_ratio, watched_symbols, start_capital_eur, balance_eur, leverage, criteria_trend_enabled, criteria_volume_enabled, criteria_mtf_enabled)
       VALUES (1, false, $1, $2, $3, $4, $4, $5, $6, $7, $8)`,
      [PAPER_DEFAULT_SETTINGS.riskPerTradeEur, PAPER_DEFAULT_SETTINGS.riskRewardRatio, PAPER_DEFAULT_SETTINGS.watchedSymbols, PAPER_DEFAULT_SETTINGS.startCapitalEur, PAPER_DEFAULT_SETTINGS.leverage, PAPER_DEFAULT_SETTINGS.criteriaTrendEnabled, PAPER_DEFAULT_SETTINGS.criteriaVolumeEnabled, PAPER_DEFAULT_SETTINGS.criteriaMtfEnabled]
    );
    await pgPool.query('INSERT INTO paper_balance_history (balance) VALUES ($1)', [PAPER_DEFAULT_SETTINGS.startCapitalEur]);
  }
  const { rows: insightRows } = await pgPool.query('SELECT id FROM paper_insights WHERE id = 1');
  if (!insightRows.length) {
    await pgPool.query('INSERT INTO paper_insights (id, trade_count, insight_text, generated_at) VALUES (1, 0, NULL, NULL)');
  }
}

function rowToSettings(row) {
  return {
    enabled: row.enabled,
    riskPerTradeEur: Number(row.risk_per_trade_eur),
    riskRewardRatio: Number(row.risk_reward_ratio),
    watchedSymbols: row.watched_symbols,
    startCapitalEur: Number(row.start_capital_eur),
    balanceEur: Number(row.balance_eur),
    maxOpenPositions: Number(row.max_open_positions),
    leverage: Number(row.leverage),
    criteriaTrendEnabled: row.criteria_trend_enabled,
    criteriaVolumeEnabled: row.criteria_volume_enabled,
    criteriaMtfEnabled: row.criteria_mtf_enabled,
    lastCheck: row.last_check ? new Date(row.last_check).getTime() : null
  };
}

async function getPaperSettings() {
  const { rows } = await pgPool.query('SELECT * FROM paper_settings WHERE id = 1');
  return rowToSettings(rows[0]);
}

function rowToTrade(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    positionSizeEur: Number(row.position_size_eur),
    riskEur: Number(row.risk_eur),
    leverage: Number(row.leverage),
    marginEur: Number(row.margin_eur),
    liquidationPrice: row.liquidation_price != null ? Number(row.liquidation_price) : null,
    liquidatesFirst: row.liquidates_first,
    criteriaTrend: row.criteria_trend,
    criteriaVolume: row.criteria_volume,
    criteriaMtf: row.criteria_mtf,
    geminiReasoning: row.gemini_reasoning,
    flaggedBuggy: row.flagged_buggy,
    reason: row.reason,
    openedAt: new Date(row.opened_at).getTime(),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    closeReason: row.close_reason,
    pnlEur: row.pnl_eur != null ? Number(row.pnl_eur) : null,
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null
  };
}

function rowToSkipped(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    reason: row.reason,
    criteriaTrend: row.criteria_trend,
    criteriaVolume: row.criteria_volume,
    criteriaMtf: row.criteria_mtf,
    geminiReasoning: row.gemini_reasoning,
    createdAt: new Date(row.created_at).getTime()
  };
}

async function fetchPaperCandles(symbol, interval = '15m', limit = 200) {
  const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`Kline-Fehler für ${symbol}: HTTP ${res.status}`);
  const raw = await res.json();
  return raw.map(k => ({
    time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
    volume: Number(k[5])
  }));
}

// Lokale Hoch-/Tiefpunkte: eine Kerze gilt als "lokal", wenn ihr High/Low
// extremer ist als das der `lookback` Kerzen davor UND danach.
function findLocalExtrema(candles, lookback = 4) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const windowSlice = candles.slice(i - lookback, i + lookback + 1);
    if (candles[i].high === Math.max(...windowSlice.map(c => c.high))) {
      highs.push({ index: i, price: candles[i].high });
    }
    if (candles[i].low === Math.min(...windowSlice.map(c => c.low))) {
      lows.push({ index: i, price: candles[i].low });
    }
  }
  return { highs, lows };
}

// Vereinfachte Heuristik, keine Garantie für korrekte Mustererkennung.
// Erkennt: Liquidation Sweep (Docht durchbricht ein vorheriges lokales
// Hoch/Tief, Schlusskurs kehrt zurück) gefolgt von einem Break of
// Structure (Schlusskurs durchbricht ein vorheriges lokales Hoch/Tief)
// innerhalb eines Fensters von ~15 Kerzen, nahe (<=3%, gelockert von 2%) der Sweep-Zone.
// Interpretation der "Support/Resistance-Nähe": die gesweepte Zone
// selbst dient als Referenzlevel für die Abstandsprüfung.
function detectPaperSetup(candles) {
  const { highs, lows } = findLocalExtrema(candles, 4);
  const n = candles.length;
  const windowSize = 15;
  const searchStart = Math.max(0, n - windowSize - 10);

  const downSweeps = [];
  const upBos = [];
  for (let i = searchStart; i < n; i++) {
    const priorLows = lows.filter(l => l.index < i);
    if (priorLows.length) {
      const refLow = priorLows[priorLows.length - 1];
      if (candles[i].low < refLow.price && candles[i].close > refLow.price) {
        downSweeps.push({ index: i, sweptLevel: refLow.price, sweepExtreme: candles[i].low });
      }
    }
    const priorHighs = highs.filter(h => h.index < i);
    if (priorHighs.length) {
      const refHigh = priorHighs[priorHighs.length - 1];
      if (candles[i].close > refHigh.price) {
        upBos.push({ index: i, brokenLevel: refHigh.price });
      }
    }
  }
  for (const sweep of downSweeps) {
    const bos = upBos.find(b => b.index > sweep.index && b.index - sweep.index <= windowSize);
    if (bos) {
      const distancePct = Math.abs(candles[bos.index].close - sweep.sweptLevel) / sweep.sweptLevel * 100;
      if (distancePct <= 3) {
        return {
          direction: 'long',
          sweepExtreme: sweep.sweepExtreme,
          sweepIndex: sweep.index,
          bosIndex: bos.index,
          reason: `Liquidation Sweep unter ${sweep.sweptLevel.toFixed(4)}, danach Break of Structure über ${bos.brokenLevel.toFixed(4)} (${distancePct.toFixed(2)}% Abstand zur Zone).`
        };
      }
    }
  }

  const upSweeps = [];
  const downBos = [];
  for (let i = searchStart; i < n; i++) {
    const priorHighs = highs.filter(h => h.index < i);
    if (priorHighs.length) {
      const refHigh = priorHighs[priorHighs.length - 1];
      if (candles[i].high > refHigh.price && candles[i].close < refHigh.price) {
        upSweeps.push({ index: i, sweptLevel: refHigh.price, sweepExtreme: candles[i].high });
      }
    }
    const priorLows = lows.filter(l => l.index < i);
    if (priorLows.length) {
      const refLow = priorLows[priorLows.length - 1];
      if (candles[i].close < refLow.price) {
        downBos.push({ index: i, brokenLevel: refLow.price });
      }
    }
  }
  for (const sweep of upSweeps) {
    const bos = downBos.find(b => b.index > sweep.index && b.index - sweep.index <= windowSize);
    if (bos) {
      const distancePct = Math.abs(candles[bos.index].close - sweep.sweptLevel) / sweep.sweptLevel * 100;
      if (distancePct <= 3) {
        return {
          direction: 'short',
          sweepExtreme: sweep.sweepExtreme,
          sweepIndex: sweep.index,
          bosIndex: bos.index,
          reason: `Liquidation Sweep über ${sweep.sweptLevel.toFixed(4)}, danach Break of Structure unter ${bos.brokenLevel.toFixed(4)} (${distancePct.toFixed(2)}% Abstand zur Zone).`
        };
      }
    }
  }

  return null;
}

// ---- Zusatz-Bestätigungskriterien (a: Trend, b: Volumen, c: Mehrere Zeitebenen) ----

// a) Trendfilter: SMA200 auf 1h-Kerzen, Fallback SMA50 falls nicht genug
// Historie vorhanden ist (Binance liefert je nach Symbol ggf. <200 1h-Kerzen
// bei sehr neuen Listings - für dieses simulierte Setting unkritisch).
function checkTrendFilter(candles1h, direction) {
  const closes = candles1h.map(c => c.close);
  const period = closes.length >= 200 ? 200 : Math.min(50, closes.length);
  if (period < 10) return { pass: false, period, sma: null }; // zu wenig Historie, sicherheitshalber ablehnen
  const sma = closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  const currentPrice = closes[closes.length - 1];
  const pass = direction === 'long' ? currentPrice > sma : currentPrice < sma;
  return { pass, period, sma };
}

// b) Volumen-Bestätigung: Volumen der BOS-Kerze (Bestätigungskerze) muss
// mindestens das 1,2-fache des Durchschnittsvolumens der letzten 20 Kerzen
// davor betragen (gelockert von ursprünglich 1,5x).
function checkVolumeConfirmation(candles, confirmIndex) {
  const start = Math.max(0, confirmIndex - 20);
  const priorVolumes = candles.slice(start, confirmIndex).map(c => c.volume);
  if (!priorVolumes.length) return { pass: false, avgVolume: 0, confirmVolume: 0 };
  const avgVolume = priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length;
  const confirmVolume = candles[confirmIndex].volume;
  return { pass: avgVolume > 0 && confirmVolume >= avgVolume * 1.2, avgVolume, confirmVolume };
}

// c) Mehrere Zeitebenen: auf dem übergeordneten 1h-Chart darf keine
// unmittelbar gegenläufige starke Struktur (lokales Hoch/Tief) in der Nähe
// (<=1%) des aktuellen Kurses liegen - sonst würde der Trade direkt in
// eine große 1h-Resistance/Support hineinlaufen.
function checkMultiTimeframe(candles1h, direction, currentPrice) {
  const { highs, lows } = findLocalExtrema(candles1h, 3);
  if (direction === 'long') {
    const nearResistance = highs.find(h => h.price > currentPrice && (h.price - currentPrice) / currentPrice <= 0.01);
    return { pass: !nearResistance, blockingLevel: nearResistance ? nearResistance.price : null };
  } else {
    const nearSupport = lows.find(l => l.price < currentPrice && (currentPrice - l.price) / currentPrice <= 0.01);
    return { pass: !nearSupport, blockingLevel: nearSupport ? nearSupport.price : null };
  }
}

// Hebel-Berechnung (siehe Erklärung im Chat für die Herleitung).
//
// KAPITAL-DECKELUNG (Bugfix - vorher konnte die Margin unbegrenzt wachsen,
// wenn der SL-Abstand sehr eng war, z.B. der ATOM-Vorfall mit 9.452€ Margin
// bei nur 100€ Start-Kapital):
// 1) Gesamt-Kaufkraft = aktuelle Paper-Balance * Hebel
// 2) Verfügbare Kaufkraft = Gesamt-Kaufkraft - Summe der Margin aller
//    aktuell bereits offenen Positionen
// 3) Maximale Margin für den NEUEN Trade = verfügbare Kaufkraft / Anzahl
//    noch freier Positions-Slots (max. offene Positionen minus bereits offene)
// 4) Die aus Risiko€/SL-Abstand "eigentlich gewünschte" Margin wird auf
//    dieses Maximum gedeckelt - das eingestellte Euro-Risiko wird dadurch
//    ggf. UNTERSCHRITTEN, nie überschritten
// 5) Notfall-Schutz: die Margin darf zusätzlich NIE die aktuelle Balance
//    selbst übersteigen, komplett unabhängig von der obigen Rechnung
function computePaperTradePlan(direction, entryPrice, sweepExtreme, settings, capContext) {
  const bufferPct = 0.0015;
  const leverage = Math.max(1, Number(settings.leverage) || 1);
  let stopLoss, distance;
  if (direction === 'long') {
    stopLoss = sweepExtreme * (1 - bufferPct);
    distance = entryPrice - stopLoss;
  } else {
    stopLoss = sweepExtreme * (1 + bufferPct);
    distance = stopLoss - entryPrice;
  }
  const distancePct = distance / entryPrice;
  const takeProfit = direction === 'long'
    ? entryPrice + distance * settings.riskRewardRatio
    : entryPrice - distance * settings.riskRewardRatio;

  const desiredMarginEur = distancePct > 0 ? settings.riskPerTradeEur / distancePct : 0;

  const totalBuyingPower = capContext.balanceEur * leverage;
  const availableBuyingPower = Math.max(0, totalBuyingPower - capContext.usedMarginEur);
  const freeSlots = Math.max(1, capContext.freeSlots);
  const maxMarginPerTrade = availableBuyingPower / freeSlots;

  let marginEur = Math.min(desiredMarginEur, maxMarginPerTrade);
  marginEur = Math.min(marginEur, capContext.balanceEur); // Notfall-Schutz (Punkt 4)
  marginEur = Math.max(0, marginEur);

  const positionSizeEur = marginEur * leverage;
  const effectiveRiskEur = positionSizeEur * distancePct;

  const liquidationDistancePct = 1 / leverage;
  const liquidationPrice = direction === 'long'
    ? entryPrice * (1 - liquidationDistancePct)
    : entryPrice * (1 + liquidationDistancePct);
  const liquidatesFirst = liquidationDistancePct < distancePct;

  return { stopLoss, takeProfit, positionSizeEur, marginEur, leverage, liquidationPrice, liquidatesFirst, effectiveRiskEur };
}

// NUR SIMULATION - prüft offene Paper-Trades auf SL/TP und öffnet ggf.
// neue Paper-Trades. Löst zu keinem Zeitpunkt eine echte Order aus.
// maxOpenPositions wird als Parameter übergeben (statt erneut abgefragt),
// da mehrere Coins pro Zyklus dieselbe Settings-Zeile teilen.
async function checkPaperSymbol(symbol, settings) {
  // Haupt-Zeitrahmen jetzt 5-Minuten-Kerzen (Punkt 1c der Erweiterung, vorher 15m).
  const candles = await fetchPaperCandles(symbol, '5m', 200);
  const lastPrice = candles[candles.length - 1].close;
  paperLastPrices[symbol] = lastPrice;

  const { rows: openRows } = await pgPool.query(
    "SELECT * FROM paper_trades WHERE symbol = $1 AND status = 'open'",
    [symbol]
  );

  for (const row of openRows) {
    const trade = rowToTrade(row);
    let closeReason = null;
    let exitPrice = lastPrice;
    let pnlEur = null;

    // NUR SIMULATION: Liquidation wird zuerst geprüft, da der Liquidationspreis
    // bei hohem Hebel näher am Einstieg liegen kann als der technische SL -
    // in der Realität würde die Position dann bereits vorher zwangsgeschlossen.
    const liquidationHit = trade.liquidationPrice != null && trade.direction === 'long'
      ? lastPrice <= trade.liquidationPrice
      : trade.liquidationPrice != null && lastPrice >= trade.liquidationPrice;

    if (trade.liquidatesFirst && liquidationHit) {
      closeReason = 'LIQUIDATION';
      exitPrice = trade.liquidationPrice;
      pnlEur = -trade.marginEur; // Totalverlust der Margin
    } else if (trade.direction === 'long') {
      if (lastPrice >= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice <= trade.stopLoss) closeReason = 'SL';
    } else {
      if (lastPrice <= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice >= trade.stopLoss) closeReason = 'SL';
    }
    if (!closeReason) continue;

    if (pnlEur === null) {
      pnlEur = trade.direction === 'long'
        ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
        : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;
    }

    await pgPool.query(
      `UPDATE paper_trades SET status = 'closed', exit_price = $1, close_reason = $2, pnl_eur = $3, closed_at = now() WHERE id = $4`,
      [exitPrice, closeReason, pnlEur, trade.id]
    );
    const { rows: balRows } = await pgPool.query(
      'UPDATE paper_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur',
      [pnlEur]
    );
    await pgPool.query('INSERT INTO paper_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);

    // Punkt 3: nach jeweils 20 geschlossenen Trades eine Gemini-Selbstauswertung
    // anstoßen (rein informativ, verändert die Regeln aus Punkt 1 nicht automatisch).
    const { rows: closedCountRows } = await pgPool.query("SELECT COUNT(*)::int AS c FROM paper_trades WHERE status = 'closed'");
    const closedCount = closedCountRows[0].c;
    if (closedCount > 0 && closedCount % 20 === 0) {
      generatePaperInsights(closedCount).catch(err => console.error('Auto Trader: Insight-Generierung fehlgeschlagen:', err.message || err));
    }
  }

  const { rows: stillOpenForSymbol } = await pgPool.query(
    "SELECT COUNT(*)::int AS c FROM paper_trades WHERE symbol = $1 AND status = 'open'",
    [symbol]
  );
  if (stillOpenForSymbol[0].c > 0) return;

  const { rows: openAggRows } = await pgPool.query(
    "SELECT COUNT(*)::int AS c, COALESCE(SUM(margin_eur), 0) AS used_margin FROM paper_trades WHERE status = 'open'"
  );
  const totalOpenCount = openAggRows[0].c;
  const usedMarginEur = Number(openAggRows[0].used_margin);
  if (totalOpenCount >= settings.maxOpenPositions) return;

  const setup = detectPaperSetup(candles);

  // Punkt 3 (Transparenz): pro Coin und Durchlauf einen Diagnose-Eintrag
  // schreiben, der zeigt, ob überhaupt ein Sweep+BOS gefunden wurde und
  // woran es ggf. gescheitert ist ("Letzte Prüfungen" auf der Auto-Trader-
  // Seite). Ein Eintrag pro Symbol (Upsert), nicht pro Historie.
  async function logCheck({ sweepBosFound, direction, failedCriteria, note }) {
    await pgPool.query(
      `INSERT INTO paper_check_log (symbol, sweep_bos_found, direction, failed_criteria, note, checked_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (symbol) DO UPDATE SET sweep_bos_found = $2, direction = $3, failed_criteria = $4, note = $5, checked_at = now()`,
      [symbol, sweepBosFound, direction || null, failedCriteria || null, note || null]
    );
  }

  if (!setup) {
    await logCheck({ sweepBosFound: false, direction: null, failedCriteria: null, note: 'Kein Sweep+BOS in diesem Zeitraum.' });
    return;
  }

  // Punkt 1: Zusatzkriterien sind pro Kriterium einzeln über die Einstellungen
  // an-/abschaltbar. Ein deaktiviertes Kriterium blockiert nie (gilt als
  // automatisch erfüllt), nur aktivierte Kriterien müssen tatsächlich passen.
  const candles1h = await fetchPaperCandles(symbol, '1h', 200);
  const trend = checkTrendFilter(candles1h, setup.direction);
  const volume = checkVolumeConfirmation(candles, setup.bosIndex);
  const mtf = checkMultiTimeframe(candles1h, setup.direction, lastPrice);
  const criteria = { trend, volume, mtf };

  const failed = [];
  if (settings.criteriaTrendEnabled && !trend.pass) failed.push('Trendfilter');
  if (settings.criteriaVolumeEnabled && !volume.pass) failed.push('Volumen-Bestätigung');
  if (settings.criteriaMtfEnabled && !mtf.pass) failed.push('Mehrzeitebenen-Check');

  if (failed.length) {
    await logCheck({ sweepBosFound: true, direction: setup.direction, failedCriteria: failed.join(', '), note: `Sweep+BOS gefunden, aber ${failed.join(', ')} nicht erfüllt.` });
    // Technisch gescheiterte Setups landen jetzt (statt der früheren
    // Gemini-Ablehnungen) in "Übersprungene Setups", damit nachvollziehbar
    // bleibt, was erkannt aber wegen der Zusatzkriterien verworfen wurde.
    await pgPool.query(
      `INSERT INTO paper_skipped_setups (id, symbol, direction, reason, criteria_trend, criteria_volume, criteria_mtf, gemini_reasoning)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [crypto.randomUUID(), symbol, setup.direction, setup.reason, trend.pass, volume.pass, mtf.pass]
    );
    return;
  }

  await logCheck({ sweepBosFound: true, direction: setup.direction, failedCriteria: null, note: 'Sweep+BOS gefunden, alle aktivierten Zusatzkriterien erfüllt - Trade eröffnet.' });

  // Kein Gemini-Gegencheck mehr: Trade wird direkt eröffnet, sobald alle
  // aktivierten technischen Kriterien erfüllt sind - Positionsgröße wird
  // dabei auf die verfügbare Kaufkraft gedeckelt (siehe computePaperTradePlan).
  const entryPrice = lastPrice;
  const freeSlots = settings.maxOpenPositions - totalOpenCount;
  const capContext = { balanceEur: settings.balanceEur, usedMarginEur, freeSlots };
  const plan = computePaperTradePlan(setup.direction, entryPrice, setup.sweepExtreme, settings, capContext);

  if (plan.marginEur < 0.01) {
    await logCheck({ sweepBosFound: true, direction: setup.direction, failedCriteria: 'Kapital', note: 'Sweep+BOS gefunden, aber keine verfügbare Kaufkraft mehr für eine neue Position.' });
    return;
  }

  await pgPool.query(
    `INSERT INTO paper_trades (id, symbol, direction, entry_price, stop_loss, take_profit, position_size_eur, risk_eur, leverage, margin_eur, liquidation_price, liquidates_first, criteria_trend, criteria_volume, criteria_mtf, reason, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'open', now())`,
    [crypto.randomUUID(), symbol, setup.direction, entryPrice, plan.stopLoss, plan.takeProfit, plan.positionSizeEur, plan.effectiveRiskEur, plan.leverage, plan.marginEur, plan.liquidationPrice, plan.liquidatesFirst, trend.pass, volume.pass, mtf.pass, setup.reason]
  );
}

// Punkt 3: NUR informative Selbstauswertung - verändert nie automatisch die
// Regeln aus Punkt 1, sondern liefert dem Nutzer Text zur manuellen Auswertung.
async function generatePaperInsights(closedCount) {
  const { rows } = await pgPool.query(
    "SELECT symbol, direction, pnl_eur, criteria_trend, criteria_volume, criteria_mtf, closed_at FROM paper_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 100"
  );
  const summaryLines = rows.map(r => {
    const hour = new Date(r.closed_at).getUTCHours();
    const result = Number(r.pnl_eur) >= 0 ? 'GEWINN' : 'VERLUST';
    return `${r.symbol} ${r.direction} | Trend:${r.criteria_trend ? 'J' : 'N'} Volumen:${r.criteria_volume ? 'J' : 'N'} MTF:${r.criteria_mtf ? 'J' : 'N'} | Stunde:${hour} | ${result}`;
  }).join('\n');

  const prompt = `Du analysierst die Historie eines simulierten Krypto-Paper-Trading-Bots (kein echtes Geld). Hier die letzten ${rows.length} geschlossenen Trades (Coin, Richtung, ob die Zusatzkriterien Trend/Volumen/Mehrere-Zeitebenen erfüllt waren, Schlussstunde UTC, Ergebnis):

${summaryLines}

Erkenne Muster, z.B. ob bestimmte Kriterien-Kombinationen, Coins oder Tageszeiten auffällig besser oder schlechter abschneiden. Fasse deine Erkenntnisse in 3-5 kurzen, konkreten Sätzen zusammen (auf Deutsch). Keine Handlungsempfehlung, nur Beobachtungen.`;

  const text = await callGeminiText(prompt);
  const insightText = text || 'Gemini nicht konfiguriert oder nicht erreichbar - keine automatische Auswertung möglich.';
  await pgPool.query(
    'UPDATE paper_insights SET trade_count = $1, insight_text = $2, generated_at = now() WHERE id = 1',
    [closedCount, insightText]
  );
}

async function runPaperTradingCycle() {
  if (!pgPool) return;
  const settings = await getPaperSettings();
  if (!settings.enabled) return;
  for (const symbol of settings.watchedSymbols) {
    try {
      await checkPaperSymbol(symbol, settings);
    } catch (err) {
      console.error(`Paper-Trading-Fehler bei ${symbol}:`, err.message || err);
    }
    await sleep(150); // entzerrt die Binance-Anfragen etwas, statt sie im Burst zu feuern
  }
  await pgPool.query('UPDATE paper_settings SET last_check = now() WHERE id = 1');
}

const PAPER_CHECK_INTERVAL_MS = 2 * 60 * 1000; // alle 2 Minuten (vorher 7 - responsiver, ohne Server-Last zu sprengen)
setInterval(runPaperTradingCycle, PAPER_CHECK_INTERVAL_MS);

app.get('/api/paper-trading/state', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Auto Trader nicht verfügbar.' });
  try {
    const settings = await getPaperSettings();
    const { rows: openRows } = await pgPool.query("SELECT * FROM paper_trades WHERE status = 'open' ORDER BY opened_at DESC");
    const { rows: closedRows } = await pgPool.query("SELECT * FROM paper_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
    const { rows: historyRows } = await pgPool.query('SELECT time, balance FROM paper_balance_history ORDER BY time ASC');
    const { rows: skippedRows } = await pgPool.query('SELECT * FROM paper_skipped_setups ORDER BY created_at DESC LIMIT 50');
    const { rows: insightRows } = await pgPool.query('SELECT trade_count, insight_text, generated_at FROM paper_insights WHERE id = 1');
    const { rows: checkLogRows } = await pgPool.query('SELECT * FROM paper_check_log ORDER BY checked_at DESC');

    const openTrades = openRows.map(rowToTrade).map(t => {
      const currentPrice = paperLastPrices[t.symbol] ?? null;
      let unrealizedPnlEur = null;
      if (currentPrice != null) {
        unrealizedPnlEur = t.direction === 'long'
          ? (currentPrice - t.entryPrice) / t.entryPrice * t.positionSizeEur
          : (t.entryPrice - currentPrice) / t.entryPrice * t.positionSizeEur;
      }
      return { ...t, currentPrice, unrealizedPnlEur };
    });
    const closedTrades = closedRows.map(rowToTrade);
    const balanceHistory = historyRows.map(r => ({ time: new Date(r.time).getTime(), balance: Number(r.balance) }));
    const skippedSetups = skippedRows.map(rowToSkipped);
    const insights = insightRows.length ? {
      tradeCount: insightRows[0].trade_count,
      text: insightRows[0].insight_text,
      generatedAt: insightRows[0].generated_at ? new Date(insightRows[0].generated_at).getTime() : null
    } : null;
    const checkLog = checkLogRows.map(r => ({
      symbol: r.symbol,
      sweepBosFound: r.sweep_bos_found,
      direction: r.direction,
      failedCriteria: r.failed_criteria,
      note: r.note,
      checkedAt: new Date(r.checked_at).getTime()
    }));

    res.json({ settings, balanceEur: settings.balanceEur, balanceHistory, openTrades, closedTrades, skippedSetups, insights, checkLog, lastCheck: settings.lastCheck, checkIntervalMs: PAPER_CHECK_INTERVAL_MS });
  } catch (err) {
    console.error('Paper-Trading: state-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/paper-trading/settings', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Auto Trader nicht verfügbar.' });
  try {
    const incoming = req.body || {};
    const current = await getPaperSettings();
    const wasEnabled = current.enabled;
    const next = {
      enabled: !!incoming.enabled,
      riskPerTradeEur: Number(incoming.riskPerTradeEur) > 0 ? Number(incoming.riskPerTradeEur) : current.riskPerTradeEur,
      riskRewardRatio: Number(incoming.riskRewardRatio) > 0 ? Number(incoming.riskRewardRatio) : current.riskRewardRatio,
      watchedSymbols: Array.isArray(incoming.watchedSymbols) && incoming.watchedSymbols.length ? incoming.watchedSymbols : current.watchedSymbols,
      startCapitalEur: Number(incoming.startCapitalEur) > 0 ? Number(incoming.startCapitalEur) : current.startCapitalEur,
      maxOpenPositions: Number(incoming.maxOpenPositions) > 0 ? Number(incoming.maxOpenPositions) : current.maxOpenPositions,
      leverage: Number(incoming.leverage) >= 1 && Number(incoming.leverage) <= 10 ? Math.round(Number(incoming.leverage)) : current.leverage,
      criteriaTrendEnabled: incoming.criteriaTrendEnabled !== undefined ? !!incoming.criteriaTrendEnabled : current.criteriaTrendEnabled,
      criteriaVolumeEnabled: incoming.criteriaVolumeEnabled !== undefined ? !!incoming.criteriaVolumeEnabled : current.criteriaVolumeEnabled,
      criteriaMtfEnabled: incoming.criteriaMtfEnabled !== undefined ? !!incoming.criteriaMtfEnabled : current.criteriaMtfEnabled
    };
    const leverageWarning = await checkLeverageChangeWarning('paper_trades', current.leverage, next.leverage);

    await pgPool.query(
      `UPDATE paper_settings SET enabled = $1, risk_per_trade_eur = $2, risk_reward_ratio = $3, watched_symbols = $4, start_capital_eur = $5, max_open_positions = $6, leverage = $7, criteria_trend_enabled = $8, criteria_volume_enabled = $9, criteria_mtf_enabled = $10 WHERE id = 1`,
      [next.enabled, next.riskPerTradeEur, next.riskRewardRatio, next.watchedSymbols, next.startCapitalEur, next.maxOpenPositions, next.leverage, next.criteriaTrendEnabled, next.criteriaVolumeEnabled, next.criteriaMtfEnabled]
    );

    if (next.enabled && !wasEnabled) runPaperTradingCycle();
    res.json({ ok: true, settings: next, leverageWarning });
  } catch (err) {
    console.error('Paper-Trading: settings-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/paper-trading/reset', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Auto Trader nicht verfügbar.' });
  try {
    const settings = await getPaperSettings();
    await pgPool.query('DELETE FROM paper_trades');
    await pgPool.query('DELETE FROM paper_balance_history');
    await pgPool.query('DELETE FROM paper_skipped_setups');
    await pgPool.query('DELETE FROM paper_check_log');
    await pgPool.query('UPDATE paper_settings SET balance_eur = $1, last_check = NULL WHERE id = 1', [settings.startCapitalEur]);
    await pgPool.query('UPDATE paper_insights SET trade_count = 0, insight_text = NULL, generated_at = NULL WHERE id = 1');
    await pgPool.query('INSERT INTO paper_balance_history (balance) VALUES ($1)', [settings.startCapitalEur]);
    Object.keys(paperLastPrices).forEach(k => delete paperLastPrices[k]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Paper-Trading: reset-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

// NUR SIMULATION - schließt einen einzelnen offenen Paper-Trade manuell zum
// aktuellen Marktpreis (holt den Preis live von Binance, kein SL/TP-Wert).
// Löst keine echte Order aus, verändert nur die lokale Simulation.
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Holt den aktuellen Preis mit 3 Versuchen (kurze Wartezeit dazwischen), um
// vorübergehende Binance-Rate-Limits (HTTP 418/429) abzufedern. Wirft erst,
// wenn alle Versuche fehlschlagen - der Aufrufer entscheidet dann über
// einen Fallback auf den letzten bekannten Preis.
async function fetchLiveTickerPriceWithRetry(symbol, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
      if (!res.ok) throw new Error(`Ticker-Fehler für ${symbol}: HTTP ${res.status}`);
      const data = await res.json();
      return Number(data.price);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(400 * (i + 1)); // steigende Wartezeit: 400ms, 800ms
    }
  }
  throw lastErr;
}

app.post('/api/paper-trading/close/:id', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Auto Trader nicht verfügbar.' });
  try {
    const { rows } = await pgPool.query("SELECT * FROM paper_trades WHERE id = $1 AND status = 'open'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Offener Trade nicht gefunden.' });
    const trade = rowToTrade(rows[0]);

    // Fallback: falls der Live-Kurs trotz mehrerer Versuche nicht abrufbar ist
    // (Rate-Limit oder pausiertes Handelspaar), wird der letzte bekannte
    // Kurs aus dem Hintergrund-Zyklus verwendet, statt den Trade blockiert
    // zu lassen. Wird dem Frontend klar als "usedLastKnownPrice" markiert.
    let exitPrice, usedLastKnownPrice = false;
    try {
      exitPrice = await fetchLiveTickerPriceWithRetry(trade.symbol);
    } catch (err) {
      const cached = paperLastPrices[trade.symbol];
      if (cached == null) {
        return res.status(503).json({ error: `Aktueller Kurs für ${trade.symbol} nicht abrufbar (${err.message}) und kein zwischengespeicherter Preis vorhanden. Bitte später erneut versuchen.` });
      }
      exitPrice = cached;
      usedLastKnownPrice = true;
    }

    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;

    await pgPool.query(
      `UPDATE paper_trades SET status = 'closed', exit_price = $1, close_reason = 'MANUAL', pnl_eur = $2, closed_at = now() WHERE id = $3`,
      [exitPrice, pnlEur, trade.id]
    );
    const { rows: balRows } = await pgPool.query(
      'UPDATE paper_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur',
      [pnlEur]
    );
    await pgPool.query('INSERT INTO paper_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);

    const { rows: closedCountRows } = await pgPool.query("SELECT COUNT(*)::int AS c FROM paper_trades WHERE status = 'closed'");
    const closedCount = closedCountRows[0].c;
    if (closedCount > 0 && closedCount % 20 === 0) {
      generatePaperInsights(closedCount).catch(err => console.error('Auto Trader: Insight-Generierung fehlgeschlagen:', err.message || err));
    }

    res.json({ ok: true, exitPrice, pnlEur, usedLastKnownPrice });
  } catch (err) {
    console.error('Paper-Trading: manuelles Schließen fehlgeschlagen:', err);
    res.status(500).json({ error: err.message || 'Fehler beim Schließen.' });
  }
});

// ============================================================
// NY RANGE BOT - zweiter, komplett unabhängiger Paper-Trading-Bot
// (eigene Strategie, eigener Kapitalschutz, eigene DB-Tabellen "ny_*").
//
// SICHERHEIT: Wie beim ersten Bot - liest ausschließlich öffentliche
// Binance-Kursdaten, verändert nur lokal simulierte Werte. Kein
// Codepfad hier kann eine echte Order auslösen. NUR SIMULATION.
//
// STRATEGIE "NY Midnight Range Reversal":
// 1) Die 00:00-04:00-Uhr-New-York-Kerze (Zeitzone/Sommerzeit über
//    Intl-Zeitzonendatenbank berücksichtigt) markiert Hoch/Tief der
//    Tages-Range. Gültig bis zur nächsten 00:00-04:00-NY-Range.
// 2) Bricht der Kurs auf 5-Minuten-Basis aus der Range aus (Wick reicht)
//    und schließt eine 5m-Kerze wieder INNERHALB der Range, wird SOFORT
//    ein Trade GEGEN die Ausbruchsrichtung eröffnet.
// 3) SL am Extrempunkt des Ausbruchs, außer der Extrempunkt liegt >1,5%
//    von der Range-Grenze entfernt - dann wird ein lokales Pivot
//    zwischen Range-Grenze und Extrempunkt gesucht (Fallback: 1% vom
//    Einstieg). TP-Faktor gestaffelt nach SL-Enge (2x/3x/4x).
// ============================================================
const NY_DEFAULT_SETTINGS = {
  enabled: false,
  startCapitalEur: 100,
  numSlots: 5,
  leverage: 5
};

async function initNyTradingSchema() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS ny_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      start_capital_eur NUMERIC NOT NULL DEFAULT 100,
      num_slots INTEGER NOT NULL DEFAULT 5,
      leverage INTEGER NOT NULL DEFAULT 5,
      balance_eur NUMERIC NOT NULL DEFAULT 100,
      watched_symbols TEXT[] NOT NULL DEFAULT ARRAY['BTCUSDT','ETHUSDT','SOLUSDT'],
      last_check TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS ny_trades (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      stop_loss NUMERIC NOT NULL,
      take_profit NUMERIC NOT NULL,
      sl_type TEXT NOT NULL,
      rr_factor NUMERIC NOT NULL,
      margin_eur NUMERIC NOT NULL,
      position_size_eur NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      range_high NUMERIC NOT NULL,
      range_low NUMERIC NOT NULL,
      breakout_extreme NUMERIC NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL,
      exit_price NUMERIC,
      close_reason TEXT,
      pnl_eur NUMERIC,
      closed_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS ny_balance_history (
      id SERIAL PRIMARY KEY,
      time TIMESTAMPTZ NOT NULL DEFAULT now(),
      balance NUMERIC NOT NULL
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS ny_skipped_setups (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await pgPool.query('SELECT id FROM ny_settings WHERE id = 1');
  if (!rows.length) {
    await pgPool.query(
      `INSERT INTO ny_settings (id, enabled, start_capital_eur, num_slots, leverage, balance_eur, watched_symbols)
       VALUES (1, false, $1, $2, $3, $1, $4)`,
      [NY_DEFAULT_SETTINGS.startCapitalEur, NY_DEFAULT_SETTINGS.numSlots, NY_DEFAULT_SETTINGS.leverage,
       ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT']]
    );
    await pgPool.query('INSERT INTO ny_balance_history (balance) VALUES ($1)', [NY_DEFAULT_SETTINGS.startCapitalEur]);
  }
}

function nyRowToSettings(row) {
  return {
    enabled: row.enabled,
    startCapitalEur: Number(row.start_capital_eur),
    numSlots: Number(row.num_slots),
    leverage: Number(row.leverage),
    balanceEur: Number(row.balance_eur),
    watchedSymbols: row.watched_symbols,
    lastCheck: row.last_check ? new Date(row.last_check).getTime() : null
  };
}

async function getNySettings() {
  const { rows } = await pgPool.query('SELECT * FROM ny_settings WHERE id = 1');
  return nyRowToSettings(rows[0]);
}

function nyRowToTrade(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    slType: row.sl_type,
    rrFactor: Number(row.rr_factor),
    marginEur: Number(row.margin_eur),
    positionSizeEur: Number(row.position_size_eur),
    leverage: Number(row.leverage),
    rangeHigh: Number(row.range_high),
    rangeLow: Number(row.range_low),
    breakoutExtreme: Number(row.breakout_extreme),
    reason: row.reason,
    openedAt: new Date(row.opened_at).getTime(),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    closeReason: row.close_reason,
    pnlEur: row.pnl_eur != null ? Number(row.pnl_eur) : null,
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null
  };
}

const nyLastPrices = {};

// New-York-Ortszeit für einen UTC-Zeitstempel (berücksichtigt automatisch
// Sommerzeit über die Intl-Zeitzonendatenbank von Node).
function getNyParts(utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const map = {};
  dtf.formatToParts(new Date(utcMs)).forEach(p => { map[p.type] = p.value; });
  return { date: `${map.year}-${map.month}-${map.day}`, hour: Number(map.hour) === 24 ? 0 : Number(map.hour) };
}

// Aggregiert alle 5m-Kerzen, deren NY-Ortszeit zwischen 00:00 und 04:00 liegt,
// pro NY-Kalendertag zu einem Hoch/Tief. Gibt die jüngste bereits vollständig
// abgeschlossene Range zurück (gültig bis zur nächsten).
function computeNyRange(candles, intervalMs) {
  const windows = {};
  for (const c of candles) {
    const { date, hour } = getNyParts(c.time);
    if (hour >= 0 && hour < 4) {
      if (!windows[date]) windows[date] = { high: -Infinity, low: Infinity, windowEnd: 0 };
      windows[date].high = Math.max(windows[date].high, c.high);
      windows[date].low = Math.min(windows[date].low, c.low);
      windows[date].windowEnd = Math.max(windows[date].windowEnd, c.time + intervalMs);
    }
  }
  const now = Date.now();
  const validDates = Object.keys(windows).filter(d => windows[d].windowEnd <= now).sort();
  if (!validDates.length) return null;
  const latest = validDates[validDates.length - 1];
  return { high: windows[latest].high, low: windows[latest].low, date: latest };
}

// Erkennt den Ausbruch-und-Rückkehr-Moment: die aktuellste (letzte) Kerze
// schließt wieder innerhalb der Range, die Kerze(n) direkt davor lagen
// (per Schlusskurs) durchgehend außerhalb - das begrenzt das Signal auf
// genau den Übergangsmoment (kein wiederholtes Auslösen in Folgezyklen).
function detectNyRangeSetup(candles, range) {
  const n = candles.length;
  if (n < 3) return null;
  const last = candles[n - 1];
  const insideNow = last.close >= range.low && last.close <= range.high;
  if (!insideNow) return null;

  const prev = candles[n - 2];
  const prevAbove = prev.close > range.high;
  const prevBelow = prev.close < range.low;
  if (!prevAbove && !prevBelow) return null;

  let extreme = prevAbove ? Math.max(prev.high, last.high) : Math.min(prev.low, last.low);
  for (let i = n - 3; i >= 0 && i >= n - 40; i--) {
    const c = candles[i];
    const stillOutside = prevAbove ? c.close > range.high : c.close < range.low;
    if (!stillOutside) break;
    extreme = prevAbove ? Math.max(extreme, c.high) : Math.min(extreme, c.low);
  }

  return { direction: prevAbove ? 'short' : 'long', extreme, entryPrice: last.close };
}

// Sucht ein lokales Pivot-Level zwischen der Range-Grenze und dem
// Extrempunkt (3-Kerzen-Pivot-Fenster) - genutzt, wenn der Extrempunkt zu
// weit von der Range entfernt liegt (>1,5%, siehe computeNySlTp).
function findNyPivotBetween(candles, direction, boundary, extreme) {
  const { highs, lows } = findLocalExtrema(candles, 3);
  if (direction === 'short') {
    const candidates = highs.map(h => h.price).filter(p => p > boundary && p < extreme);
    return candidates.length ? Math.max(...candidates) : null;
  } else {
    const candidates = lows.map(l => l.price).filter(p => p < boundary && p > extreme);
    return candidates.length ? Math.min(...candidates) : null;
  }
}

// SL/TP-Berechnung nach Punkt 4/5 der Strategie-Vorgabe.
function computeNySlTp(direction, entryPrice, extreme, range, candles) {
  const boundary = direction === 'short' ? range.high : range.low;
  const bufferPct = 0.0015;
  const distToBoundaryPct = Math.abs(extreme - boundary) / boundary;

  let stopLoss, slType;
  if (distToBoundaryPct <= 0.015) {
    stopLoss = direction === 'short' ? extreme * (1 + bufferPct) : extreme * (1 - bufferPct);
    slType = 'extreme';
  } else {
    const pivot = findNyPivotBetween(candles, direction, boundary, extreme);
    if (pivot != null) {
      stopLoss = direction === 'short' ? pivot * (1 + bufferPct) : pivot * (1 - bufferPct);
      slType = 'pivot';
    } else {
      stopLoss = direction === 'short' ? entryPrice * 1.01 : entryPrice * 0.99;
      slType = 'fallback_1pct';
    }
  }

  const slDistPct = Math.abs(entryPrice - stopLoss) / entryPrice;
  const rrFactor = slDistPct >= 0.005 ? 2 : slDistPct >= 0.002 ? 3 : 4;
  const takeProfit = direction === 'long'
    ? entryPrice + (entryPrice - stopLoss) * rrFactor
    : entryPrice - (stopLoss - entryPrice) * rrFactor;

  return { stopLoss, takeProfit, slType, rrFactor, slDistPct };
}

async function checkNySymbol(symbol, settings) {
  const candles = await fetchPaperCandles(symbol, '5m', 576); // ~48h Historie
  const lastPrice = candles[candles.length - 1].close;
  nyLastPrices[symbol] = lastPrice;

  // Offene Trades auf SL/TP prüfen (kein Hebel-Liquidationsrisiko-Konzept
  // in diesem Bot - fixe Slot-Margin ist die einzige Verlustgrenze pro Trade).
  const { rows: openRows } = await pgPool.query("SELECT * FROM ny_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  for (const row of openRows) {
    const trade = nyRowToTrade(row);
    let closeReason = null;
    if (trade.direction === 'long') {
      if (lastPrice >= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice <= trade.stopLoss) closeReason = 'SL';
    } else {
      if (lastPrice <= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice >= trade.stopLoss) closeReason = 'SL';
    }
    if (!closeReason) continue;

    const exitPrice = lastPrice;
    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;

    await pgPool.query(
      `UPDATE ny_trades SET status = 'closed', exit_price = $1, close_reason = $2, pnl_eur = $3, closed_at = now() WHERE id = $4`,
      [exitPrice, closeReason, pnlEur, trade.id]
    );
    const { rows: balRows } = await pgPool.query(
      'UPDATE ny_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur',
      [pnlEur]
    );
    await pgPool.query('INSERT INTO ny_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);
  }

  const { rows: stillOpenForSymbol } = await pgPool.query(
    "SELECT COUNT(*)::int AS c FROM ny_trades WHERE symbol = $1 AND status = 'open'", [symbol]
  );
  if (stillOpenForSymbol[0].c > 0) return; // pro Symbol max. 1 gleichzeitiger Trade

  const range = computeNyRange(candles, 5 * 60 * 1000);
  if (!range) return;

  const setup = detectNyRangeSetup(candles, range);
  if (!setup) return;

  const plan = computeNySlTp(setup.direction, setup.entryPrice, setup.extreme, range, candles);

  // Fester Kapitalschutz (Punkt "STRIKTER KAPITALSCHUTZ"): Margin pro Slot
  // ist FEST (Start-Kapital / Anzahl Slots), nicht aus dem Risiko abgeleitet.
  // Harte Grenze: Summe aller offenen Margins darf die aktuelle Balance nie
  // übersteigen.
  const marginEur = settings.startCapitalEur / settings.numSlots;
  const { rows: usedRows } = await pgPool.query("SELECT COALESCE(SUM(margin_eur), 0) AS used FROM ny_trades WHERE status = 'open'");
  const usedMarginEur = Number(usedRows[0].used);

  const reasonText = `NY-Range ${range.low.toFixed(4)}-${range.high.toFixed(4)} (${range.date}), Ausbruch bis ${setup.extreme.toFixed(4)}, Rückkehr in Range bei ${setup.entryPrice.toFixed(4)} -> ${setup.direction === 'short' ? 'SHORT' : 'LONG'} gegen den Ausbruch. SL ${plan.slType === 'extreme' ? 'am Extrempunkt' : plan.slType === 'pivot' ? 'an lokalem Pivot' : 'Fallback 1%'}, TP-Faktor ${plan.rrFactor}x.`;

  if (usedMarginEur + marginEur > settings.balanceEur) {
    await pgPool.query(
      `INSERT INTO ny_skipped_setups (id, symbol, direction, reason) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), symbol, setup.direction, `Kein freier Slot verfügbar (Margin ${marginEur.toFixed(2)}€ würde die Balance überschreiten). ${reasonText}`]
    );
    return;
  }

  const positionSizeEur = marginEur * settings.leverage;

  await pgPool.query(
    `INSERT INTO ny_trades (id, symbol, direction, entry_price, stop_loss, take_profit, sl_type, rr_factor, margin_eur, position_size_eur, leverage, range_high, range_low, breakout_extreme, reason, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'open', now())`,
    [crypto.randomUUID(), symbol, setup.direction, setup.entryPrice, plan.stopLoss, plan.takeProfit, plan.slType, plan.rrFactor, marginEur, positionSizeEur, settings.leverage, range.high, range.low, setup.extreme, reasonText]
  );
}

async function runNyTradingCycle() {
  if (!pgPool) return;
  const settings = await getNySettings();
  if (!settings.enabled) return;
  for (const symbol of settings.watchedSymbols) {
    try {
      await checkNySymbol(symbol, settings);
    } catch (err) {
      console.error(`NY-Range-Bot-Fehler bei ${symbol}:`, err.message || err);
    }
    await sleep(150); // entzerrt die Binance-Anfragen etwas, statt sie im Burst zu feuern
  }
  await pgPool.query('UPDATE ny_settings SET last_check = now() WHERE id = 1');
}

const NY_CHECK_INTERVAL_MS = 2 * 60 * 1000; // alle 2 Minuten (vorher 5 - responsiver, ohne Server-Last zu sprengen)
setInterval(runNyTradingCycle, NY_CHECK_INTERVAL_MS);

app.get('/api/ny-trading/state', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - NY Range Bot nicht verfügbar.' });
  try {
    const settings = await getNySettings();
    const { rows: openRows } = await pgPool.query("SELECT * FROM ny_trades WHERE status = 'open' ORDER BY opened_at DESC");
    const { rows: closedRows } = await pgPool.query("SELECT * FROM ny_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
    const { rows: historyRows } = await pgPool.query('SELECT time, balance FROM ny_balance_history ORDER BY time ASC');
    const { rows: skippedRows } = await pgPool.query('SELECT * FROM ny_skipped_setups ORDER BY created_at DESC LIMIT 50');

    const openTrades = openRows.map(nyRowToTrade).map(t => {
      const currentPrice = nyLastPrices[t.symbol] ?? null;
      let unrealizedPnlEur = null;
      if (currentPrice != null) {
        unrealizedPnlEur = t.direction === 'long'
          ? (currentPrice - t.entryPrice) / t.entryPrice * t.positionSizeEur
          : (t.entryPrice - currentPrice) / t.entryPrice * t.positionSizeEur;
      }
      return { ...t, currentPrice, unrealizedPnlEur };
    });
    const closedTrades = closedRows.map(nyRowToTrade);
    const balanceHistory = historyRows.map(r => ({ time: new Date(r.time).getTime(), balance: Number(r.balance) }));
    const skippedSetups = skippedRows.map(r => ({
      id: r.id, symbol: r.symbol, direction: r.direction, reason: r.reason, createdAt: new Date(r.created_at).getTime()
    }));

    res.json({ settings, balanceEur: settings.balanceEur, balanceHistory, openTrades, closedTrades, skippedSetups, lastCheck: settings.lastCheck, checkIntervalMs: NY_CHECK_INTERVAL_MS });
  } catch (err) {
    console.error('NY Range Bot: state-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/ny-trading/settings', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - NY Range Bot nicht verfügbar.' });
  try {
    const incoming = req.body || {};
    const current = await getNySettings();
    const wasEnabled = current.enabled;
    const next = {
      enabled: !!incoming.enabled,
      startCapitalEur: Number(incoming.startCapitalEur) > 0 ? Number(incoming.startCapitalEur) : current.startCapitalEur,
      numSlots: Number(incoming.numSlots) >= 1 ? Math.round(Number(incoming.numSlots)) : current.numSlots,
      leverage: Number(incoming.leverage) >= 1 && Number(incoming.leverage) <= 10 ? Math.round(Number(incoming.leverage)) : current.leverage,
      watchedSymbols: Array.isArray(incoming.watchedSymbols) && incoming.watchedSymbols.length ? incoming.watchedSymbols : current.watchedSymbols
    };
    const leverageWarning = await checkLeverageChangeWarning('ny_trades', current.leverage, next.leverage);

    await pgPool.query(
      `UPDATE ny_settings SET enabled = $1, start_capital_eur = $2, num_slots = $3, leverage = $4, watched_symbols = $5 WHERE id = 1`,
      [next.enabled, next.startCapitalEur, next.numSlots, next.leverage, next.watchedSymbols]
    );
    if (next.enabled && !wasEnabled) runNyTradingCycle();
    res.json({ ok: true, settings: next, leverageWarning });
  } catch (err) {
    console.error('NY Range Bot: settings-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/ny-trading/reset', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - NY Range Bot nicht verfügbar.' });
  try {
    const settings = await getNySettings();
    await pgPool.query('DELETE FROM ny_trades');
    await pgPool.query('DELETE FROM ny_balance_history');
    await pgPool.query('DELETE FROM ny_skipped_setups');
    await pgPool.query('UPDATE ny_settings SET balance_eur = $1, last_check = NULL WHERE id = 1', [settings.startCapitalEur]);
    await pgPool.query('INSERT INTO ny_balance_history (balance) VALUES ($1)', [settings.startCapitalEur]);
    Object.keys(nyLastPrices).forEach(k => delete nyLastPrices[k]);
    res.json({ ok: true });
  } catch (err) {
    console.error('NY Range Bot: reset-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

// NUR SIMULATION - schließt einen einzelnen offenen NY-Range-Bot-Trade
// manuell zum aktuellen Marktpreis. Löst keine echte Order aus.
app.post('/api/ny-trading/close/:id', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - NY Range Bot nicht verfügbar.' });
  try {
    const { rows } = await pgPool.query("SELECT * FROM ny_trades WHERE id = $1 AND status = 'open'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Offener Trade nicht gefunden.' });
    const trade = nyRowToTrade(rows[0]);

    let exitPrice, usedLastKnownPrice = false;
    try {
      exitPrice = await fetchLiveTickerPriceWithRetry(trade.symbol);
    } catch (err) {
      const cached = nyLastPrices[trade.symbol];
      if (cached == null) {
        return res.status(503).json({ error: `Aktueller Kurs für ${trade.symbol} nicht abrufbar (${err.message}) und kein zwischengespeicherter Preis vorhanden. Bitte später erneut versuchen.` });
      }
      exitPrice = cached;
      usedLastKnownPrice = true;
    }

    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;

    await pgPool.query(
      `UPDATE ny_trades SET status = 'closed', exit_price = $1, close_reason = 'MANUAL', pnl_eur = $2, closed_at = now() WHERE id = $3`,
      [exitPrice, pnlEur, trade.id]
    );
    const { rows: balRows } = await pgPool.query(
      'UPDATE ny_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur',
      [pnlEur]
    );
    await pgPool.query('INSERT INTO ny_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);

    res.json({ ok: true, exitPrice, pnlEur, usedLastKnownPrice });
  } catch (err) {
    console.error('NY Range Bot: manuelles Schließen fehlgeschlagen:', err);
    res.status(500).json({ error: err.message || 'Fehler beim Schließen.' });
  }
});

// ============================================================
// SCALPING BOT - dritter, komplett unabhängiger Paper-Trading-Bot
// (eigene Strategie, eigener Kapitalschutz, eigene DB-Tabellen "scalp_*").
//
// SICHERHEIT: Wie bei den anderen Bots - liest ausschließlich öffentliche
// Binance-Kursdaten, verändert nur lokal simulierte Werte. Kein Codepfad
// hier kann eine echte Order auslösen. NUR SIMULATION.
//
// STRATEGIE "Parabolic SAR + RSI Scalping" auf 5-Minuten-Basis:
// 1) Parabolic SAR wechselt die Seite (Trendwechsel-Signal)
// 2) RSI(14) bestätigt: entweder neutral (40-60) oder kommt gerade aus
//    überverkauft/überkauft zurück (Kreuzung 30 bzw. 70)
// 3) SL am letzten SAR-Punkt der vorherigen Trendrichtung, mindestens
//    0,15% vom Einstieg entfernt. TP = 2x SL-Distanz (festes RR 1:2).
// ============================================================
const SCALP_DEFAULT_SETTINGS = {
  enabled: false,
  startCapitalEur: 100,
  numSlots: 5,
  leverage: 5,
  criteriaTrendEnabled: true,
  criteriaVolumeEnabled: false,
  criteriaVolatilityEnabled: false
};

async function initScalpTradingSchema() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS scalp_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      start_capital_eur NUMERIC NOT NULL DEFAULT 100,
      num_slots INTEGER NOT NULL DEFAULT 5,
      leverage INTEGER NOT NULL DEFAULT 5,
      balance_eur NUMERIC NOT NULL DEFAULT 100,
      watched_symbols TEXT[] NOT NULL DEFAULT ARRAY['BTCUSDT','ETHUSDT','SOLUSDT'],
      last_check TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS scalp_trades (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      stop_loss NUMERIC NOT NULL,
      take_profit NUMERIC NOT NULL,
      prior_sar NUMERIC NOT NULL,
      rsi_at_entry NUMERIC NOT NULL,
      margin_eur NUMERIC NOT NULL,
      position_size_eur NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL,
      exit_price NUMERIC,
      close_reason TEXT,
      pnl_eur NUMERIC,
      closed_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS scalp_balance_history (
      id SERIAL PRIMARY KEY,
      time TIMESTAMPTZ NOT NULL DEFAULT now(),
      balance NUMERIC NOT NULL
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS scalp_skipped_setups (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS scalp_check_log (
      symbol TEXT PRIMARY KEY,
      signal_found BOOLEAN NOT NULL DEFAULT false,
      direction TEXT,
      failed_criteria TEXT,
      note TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migration für die neuen Zusatzfilter-Spalten (nachträglich hinzugekommen -
  // CREATE TABLE IF NOT EXISTS ergänzt bei bereits existierenden Tabellen
  // keine neuen Spalten, daher hier explizit per ALTER nachziehen).
  await pgPool.query('ALTER TABLE scalp_settings ADD COLUMN IF NOT EXISTS criteria_trend_enabled BOOLEAN NOT NULL DEFAULT true');
  await pgPool.query('ALTER TABLE scalp_settings ADD COLUMN IF NOT EXISTS criteria_volume_enabled BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE scalp_settings ADD COLUMN IF NOT EXISTS criteria_volatility_enabled BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS criteria_trend BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS criteria_volume BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS criteria_volatility BOOLEAN NOT NULL DEFAULT false');

  const { rows } = await pgPool.query('SELECT id FROM scalp_settings WHERE id = 1');
  if (!rows.length) {
    await pgPool.query(
      `INSERT INTO scalp_settings (id, enabled, start_capital_eur, num_slots, leverage, balance_eur, watched_symbols, criteria_trend_enabled, criteria_volume_enabled, criteria_volatility_enabled)
       VALUES (1, false, $1, $2, $3, $1, $4, $5, $6, $7)`,
      [SCALP_DEFAULT_SETTINGS.startCapitalEur, SCALP_DEFAULT_SETTINGS.numSlots, SCALP_DEFAULT_SETTINGS.leverage,
       ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT'],
       SCALP_DEFAULT_SETTINGS.criteriaTrendEnabled, SCALP_DEFAULT_SETTINGS.criteriaVolumeEnabled, SCALP_DEFAULT_SETTINGS.criteriaVolatilityEnabled]
    );
    await pgPool.query('INSERT INTO scalp_balance_history (balance) VALUES ($1)', [SCALP_DEFAULT_SETTINGS.startCapitalEur]);
  }
}

function scalpRowToSettings(row) {
  return {
    enabled: row.enabled,
    startCapitalEur: Number(row.start_capital_eur),
    numSlots: Number(row.num_slots),
    leverage: Number(row.leverage),
    balanceEur: Number(row.balance_eur),
    watchedSymbols: row.watched_symbols,
    criteriaTrendEnabled: row.criteria_trend_enabled,
    criteriaVolumeEnabled: row.criteria_volume_enabled,
    criteriaVolatilityEnabled: row.criteria_volatility_enabled,
    lastCheck: row.last_check ? new Date(row.last_check).getTime() : null
  };
}

async function getScalpSettings() {
  const { rows } = await pgPool.query('SELECT * FROM scalp_settings WHERE id = 1');
  return scalpRowToSettings(rows[0]);
}

function scalpRowToTrade(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    priorSar: Number(row.prior_sar),
    rsiAtEntry: Number(row.rsi_at_entry),
    marginEur: Number(row.margin_eur),
    positionSizeEur: Number(row.position_size_eur),
    leverage: Number(row.leverage),
    criteriaTrend: row.criteria_trend,
    criteriaVolume: row.criteria_volume,
    criteriaVolatility: row.criteria_volatility,
    reason: row.reason,
    openedAt: new Date(row.opened_at).getTime(),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    closeReason: row.close_reason,
    pnlEur: row.pnl_eur != null ? Number(row.pnl_eur) : null,
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null
  };
}

const scalpLastPrices = {};

// Standard-Parabolic-SAR (Wilder), Start/Increment/Max = 0.02/0.02/0.2.
// Gibt pro Kerze { sar, isLong } zurück (isLong = SAR liegt unter dem Kurs,
// also Aufwärtstrend-Zustand an dieser Kerze).
function computeParabolicSAR(candles, step = 0.02, maxStep = 0.2) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < 3) return out;

  let isLong = candles[1].close > candles[0].close;
  let af = step;
  let ep = isLong ? candles[0].high : candles[0].low;
  let sar = isLong ? candles[0].low : candles[0].high;
  out[0] = { sar, isLong };

  for (let i = 1; i < n; i++) {
    let nextSar = sar + af * (ep - sar);
    if (isLong) {
      const clampLow = Math.min(candles[i - 1].low, candles[i - 2] ? candles[i - 2].low : candles[i - 1].low);
      nextSar = Math.min(nextSar, clampLow);
      if (candles[i].low < nextSar) {
        isLong = false;
        nextSar = ep;
        ep = candles[i].low;
        af = step;
      } else if (candles[i].high > ep) {
        ep = candles[i].high;
        af = Math.min(af + step, maxStep);
      }
    } else {
      const clampHigh = Math.max(candles[i - 1].high, candles[i - 2] ? candles[i - 2].high : candles[i - 1].high);
      nextSar = Math.max(nextSar, clampHigh);
      if (candles[i].high > nextSar) {
        isLong = true;
        nextSar = ep;
        ep = candles[i].high;
        af = step;
      } else if (candles[i].low < ep) {
        ep = candles[i].low;
        af = Math.min(af + step, maxStep);
      }
    }
    sar = nextSar;
    out[i] = { sar, isLong };
  }
  return out;
}

// RSI(14) als Zeitreihe (Wilder-Glättung), damit "kommt gerade aus
// über-/unterverkauft zurück" über mehrere Kerzen hinweg geprüft werden kann.
function computeRsiSeries(candles, period = 14) {
  const closes = candles.map(c => c.close);
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Vereinfachte Heuristik. Erkennt SAR-Seitenwechsel an der letzten Kerze,
// bestätigt durch RSI (neutral 40-60, oder Rückkehr aus über-/unterverkauft
// in den letzten 5 Kerzen vor der Signalkerze).
function detectScalpSetup(candles) {
  const n = candles.length;
  if (n < 20) return null;
  const sarSeries = computeParabolicSAR(candles);
  const rsiSeries = computeRsiSeries(candles);
  const last = sarSeries[n - 1], prev = sarSeries[n - 2];
  if (!last || !prev || last.isLong === prev.isLong) return null; // kein frischer Wechsel

  const direction = last.isLong ? 'long' : 'short';
  const rsiNow = rsiSeries[n - 1];
  if (rsiNow == null) return null;

  let rsiConfirms = false;
  if (rsiNow >= 40 && rsiNow <= 60) {
    rsiConfirms = true;
  } else if (direction === 'long' && rsiNow > 30) {
    for (let i = n - 6; i < n - 1; i++) {
      if (i >= 0 && rsiSeries[i] != null && rsiSeries[i] < 30) { rsiConfirms = true; break; }
    }
  } else if (direction === 'short' && rsiNow < 70) {
    for (let i = n - 6; i < n - 1; i++) {
      if (i >= 0 && rsiSeries[i] != null && rsiSeries[i] > 70) { rsiConfirms = true; break; }
    }
  }
  if (!rsiConfirms) return null;

  return { direction, priorSar: prev.sar, rsi: rsiNow, entryPrice: candles[n - 1].close };
}

// SL am letzten SAR-Punkt der vorherigen Trendrichtung, Mindestabstand 0,15%.
// TP = festes RR 1:2.
function computeScalpSlTp(direction, entryPrice, priorSar) {
  const minDistPct = 0.0015;
  let stopLoss = priorSar;
  const rawDistPct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (rawDistPct < minDistPct) {
    stopLoss = direction === 'long' ? entryPrice * (1 - minDistPct) : entryPrice * (1 + minDistPct);
  }
  const distance = Math.abs(entryPrice - stopLoss);
  const takeProfit = direction === 'long' ? entryPrice + distance * 2 : entryPrice - distance * 2;
  return { stopLoss, takeProfit };
}

// ---- Zusatzfilter für den Scalping Bot (einzeln über die Einstellungen
// an-/abschaltbar, Standard: nur Trendfilter aktiv) ----

function computeEma(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

// a) Trendfilter: EMA200 auf 1h. Long nur über der EMA, Short nur darunter.
function checkScalpTrendFilter(candles1h, direction) {
  const closes = candles1h.map(c => c.close);
  const ema200 = computeEma(closes, Math.min(200, closes.length));
  if (ema200 == null) return { pass: false, ema200: null };
  const currentPrice = closes[closes.length - 1];
  const pass = direction === 'long' ? currentPrice > ema200 : currentPrice < ema200;
  return { pass, ema200 };
}

// b) Volumen-Bestätigung: Signalkerze (letzte Kerze) >= 1,3x Ø der letzten 20 Kerzen davor.
function checkScalpVolumeConfirmation(candles) {
  const n = candles.length;
  const priorVolumes = candles.slice(Math.max(0, n - 21), n - 1).map(c => c.volume);
  if (!priorVolumes.length) return { pass: false, avgVolume: 0 };
  const avgVolume = priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length;
  const signalVolume = candles[n - 1].volume;
  return { pass: avgVolume > 0 && signalVolume >= avgVolume * 1.3, avgVolume, signalVolume };
}

// c) Marktphasen-/Volatilitätsfilter: Ø-Kerzenspanne der letzten 20 Kerzen
// muss mindestens 50% der Ø-Kerzenspanne der letzten 100 Kerzen betragen -
// filtert sehr ruhige, richtungslose Phasen heraus.
function checkScalpVolatilityFilter(candles) {
  const n = candles.length;
  const range = c => c.high - c.low;
  const last20 = candles.slice(Math.max(0, n - 20), n);
  const last100 = candles.slice(Math.max(0, n - 100), n);
  if (!last20.length || !last100.length) return { pass: false };
  const avg20 = last20.reduce((s, c) => s + range(c), 0) / last20.length;
  const avg100 = last100.reduce((s, c) => s + range(c), 0) / last100.length;
  return { pass: avg100 > 0 && avg20 >= avg100 * 0.5, avg20, avg100 };
}

async function checkScalpSymbol(symbol, settings) {
  const candles = await fetchPaperCandles(symbol, '5m', 200);
  const lastPrice = candles[candles.length - 1].close;
  scalpLastPrices[symbol] = lastPrice;

  const { rows: openRows } = await pgPool.query("SELECT * FROM scalp_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  for (const row of openRows) {
    const trade = scalpRowToTrade(row);
    let closeReason = null;
    if (trade.direction === 'long') {
      if (lastPrice >= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice <= trade.stopLoss) closeReason = 'SL';
    } else {
      if (lastPrice <= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice >= trade.stopLoss) closeReason = 'SL';
    }
    if (!closeReason) continue;

    const exitPrice = lastPrice;
    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;

    await pgPool.query(
      `UPDATE scalp_trades SET status = 'closed', exit_price = $1, close_reason = $2, pnl_eur = $3, closed_at = now() WHERE id = $4`,
      [exitPrice, closeReason, pnlEur, trade.id]
    );
    const { rows: balRows } = await pgPool.query(
      'UPDATE scalp_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur',
      [pnlEur]
    );
    await pgPool.query('INSERT INTO scalp_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);
  }

  const { rows: stillOpenForSymbol } = await pgPool.query(
    "SELECT COUNT(*)::int AS c FROM scalp_trades WHERE symbol = $1 AND status = 'open'", [symbol]
  );
  if (stillOpenForSymbol[0].c > 0) return;

  async function logScalpCheck({ signalFound, direction, failedCriteria, note }) {
    await pgPool.query(
      `INSERT INTO scalp_check_log (symbol, signal_found, direction, failed_criteria, note, checked_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (symbol) DO UPDATE SET signal_found = $2, direction = $3, failed_criteria = $4, note = $5, checked_at = now()`,
      [symbol, signalFound, direction || null, failedCriteria || null, note || null]
    );
  }

  const setup = detectScalpSetup(candles);
  if (!setup) {
    await logScalpCheck({ signalFound: false, direction: null, failedCriteria: null, note: 'Kein SAR+RSI-Signal in diesem Zeitraum.' });
    return;
  }

  // Zusatzfilter: einzeln über die Einstellungen an-/abschaltbar. Ein
  // deaktiviertes Kriterium blockiert nie, nur aktivierte müssen passen.
  const candles1h = await fetchPaperCandles(symbol, '1h', 200);
  const trend = checkScalpTrendFilter(candles1h, setup.direction);
  const volume = checkScalpVolumeConfirmation(candles);
  const volatility = checkScalpVolatilityFilter(candles);

  const failed = [];
  if (settings.criteriaTrendEnabled && !trend.pass) failed.push('Trendfilter');
  if (settings.criteriaVolumeEnabled && !volume.pass) failed.push('Volumen-Bestätigung');
  if (settings.criteriaVolatilityEnabled && !volatility.pass) failed.push('Marktphasenfilter');

  if (failed.length) {
    await logScalpCheck({ signalFound: true, direction: setup.direction, failedCriteria: failed.join(', '), note: `SAR+RSI-Signal gefunden, aber ${failed.join(', ')} nicht erfüllt.` });
    return;
  }

  await logScalpCheck({ signalFound: true, direction: setup.direction, failedCriteria: null, note: 'SAR+RSI-Signal gefunden, alle aktivierten Zusatzfilter erfüllt - Trade eröffnet.' });

  const plan = computeScalpSlTp(setup.direction, setup.entryPrice, setup.priorSar);

  // Fester Kapitalschutz, identisch zum NY Range Bot: feste Margin pro Slot,
  // harte Grenze über alle offenen Trades hinweg gegen die aktuelle Balance.
  const marginEur = settings.startCapitalEur / settings.numSlots;
  const { rows: usedRows } = await pgPool.query("SELECT COALESCE(SUM(margin_eur), 0) AS used FROM scalp_trades WHERE status = 'open'");
  const usedMarginEur = Number(usedRows[0].used);

  const reasonText = `Parabolic-SAR-Wechsel zu ${setup.direction === 'long' ? 'Aufwärtstrend' : 'Abwärtstrend'} (letzter SAR der Vorphase: ${setup.priorSar.toFixed(4)}), RSI(14) bei ${setup.rsi.toFixed(1)} bestätigt.`;

  if (usedMarginEur + marginEur > settings.balanceEur) {
    await pgPool.query(
      `INSERT INTO scalp_skipped_setups (id, symbol, direction, reason) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), symbol, setup.direction, `Kein freier Slot verfügbar (Margin ${marginEur.toFixed(2)}€ würde die Balance überschreiten). ${reasonText}`]
    );
    return;
  }

  const positionSizeEur = marginEur * settings.leverage;

  await pgPool.query(
    `INSERT INTO scalp_trades (id, symbol, direction, entry_price, stop_loss, take_profit, prior_sar, rsi_at_entry, margin_eur, position_size_eur, leverage, criteria_trend, criteria_volume, criteria_volatility, reason, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'open', now())`,
    [crypto.randomUUID(), symbol, setup.direction, setup.entryPrice, plan.stopLoss, plan.takeProfit, setup.priorSar, setup.rsi, marginEur, positionSizeEur, settings.leverage, trend.pass, volume.pass, volatility.pass, reasonText]
  );
}

async function runScalpTradingCycle() {
  if (!pgPool) return;
  const settings = await getScalpSettings();
  if (!settings.enabled) return;
  for (const symbol of settings.watchedSymbols) {
    try {
      await checkScalpSymbol(symbol, settings);
    } catch (err) {
      console.error(`Scalping-Bot-Fehler bei ${symbol}:`, err.message || err);
    }
    await sleep(150);
  }
  await pgPool.query('UPDATE scalp_settings SET last_check = now() WHERE id = 1');
}

// 90 Sekunden: zwischen den 2 Minuten der anderen Bots und dem theoretisch
// möglichen Minimum. 5m-Kerzen liefern ohnehin nur alle 5 Minuten ein neues
// abgeschlossenes Signal, häufiger als ~1-2 Min zu prüfen brächte keine
// zusätzlichen Signale, nur mehr Last. 90s liegt in der gewünschten
// 1-2-Minuten-Spanne und bleibt zusammen mit den anderen zwei Bots (2 Min,
// 33 statt 35 Coins, 150ms-Pause pro Coin) im Rahmen, der die Binance-
// IP-Sperre von vorhin ausgelöst hat, um das nicht zu wiederholen.
const SCALP_CHECK_INTERVAL_MS = 90 * 1000;
setInterval(runScalpTradingCycle, SCALP_CHECK_INTERVAL_MS);

app.get('/api/scalp-trading/state', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Scalping Bot nicht verfügbar.' });
  try {
    const settings = await getScalpSettings();
    const { rows: openRows } = await pgPool.query("SELECT * FROM scalp_trades WHERE status = 'open' ORDER BY opened_at DESC");
    const { rows: closedRows } = await pgPool.query("SELECT * FROM scalp_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
    const { rows: historyRows } = await pgPool.query('SELECT time, balance FROM scalp_balance_history ORDER BY time ASC');
    const { rows: skippedRows } = await pgPool.query('SELECT * FROM scalp_skipped_setups ORDER BY created_at DESC LIMIT 50');
    const { rows: checkLogRows } = await pgPool.query('SELECT * FROM scalp_check_log ORDER BY checked_at DESC');

    const openTrades = openRows.map(scalpRowToTrade).map(t => {
      const currentPrice = scalpLastPrices[t.symbol] ?? null;
      let unrealizedPnlEur = null;
      if (currentPrice != null) {
        unrealizedPnlEur = t.direction === 'long'
          ? (currentPrice - t.entryPrice) / t.entryPrice * t.positionSizeEur
          : (t.entryPrice - currentPrice) / t.entryPrice * t.positionSizeEur;
      }
      return { ...t, currentPrice, unrealizedPnlEur };
    });
    const closedTrades = closedRows.map(scalpRowToTrade);
    const balanceHistory = historyRows.map(r => ({ time: new Date(r.time).getTime(), balance: Number(r.balance) }));
    const skippedSetups = skippedRows.map(r => ({
      id: r.id, symbol: r.symbol, direction: r.direction, reason: r.reason, createdAt: new Date(r.created_at).getTime()
    }));
    const checkLog = checkLogRows.map(r => ({
      symbol: r.symbol, signalFound: r.signal_found, direction: r.direction,
      failedCriteria: r.failed_criteria, note: r.note, checkedAt: new Date(r.checked_at).getTime()
    }));

    res.json({ settings, balanceEur: settings.balanceEur, balanceHistory, openTrades, closedTrades, skippedSetups, checkLog, lastCheck: settings.lastCheck, checkIntervalMs: SCALP_CHECK_INTERVAL_MS });
  } catch (err) {
    console.error('Scalping Bot: state-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/scalp-trading/settings', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Scalping Bot nicht verfügbar.' });
  try {
    const incoming = req.body || {};
    const current = await getScalpSettings();
    const wasEnabled = current.enabled;
    const next = {
      enabled: !!incoming.enabled,
      startCapitalEur: Number(incoming.startCapitalEur) > 0 ? Number(incoming.startCapitalEur) : current.startCapitalEur,
      numSlots: Number(incoming.numSlots) >= 1 ? Math.round(Number(incoming.numSlots)) : current.numSlots,
      leverage: Number(incoming.leverage) >= 1 && Number(incoming.leverage) <= 10 ? Math.round(Number(incoming.leverage)) : current.leverage,
      watchedSymbols: Array.isArray(incoming.watchedSymbols) && incoming.watchedSymbols.length ? incoming.watchedSymbols : current.watchedSymbols,
      criteriaTrendEnabled: incoming.criteriaTrendEnabled !== undefined ? !!incoming.criteriaTrendEnabled : current.criteriaTrendEnabled,
      criteriaVolumeEnabled: incoming.criteriaVolumeEnabled !== undefined ? !!incoming.criteriaVolumeEnabled : current.criteriaVolumeEnabled,
      criteriaVolatilityEnabled: incoming.criteriaVolatilityEnabled !== undefined ? !!incoming.criteriaVolatilityEnabled : current.criteriaVolatilityEnabled
    };
    const leverageWarning = await checkLeverageChangeWarning('scalp_trades', current.leverage, next.leverage);

    await pgPool.query(
      `UPDATE scalp_settings SET enabled = $1, start_capital_eur = $2, num_slots = $3, leverage = $4, watched_symbols = $5, criteria_trend_enabled = $6, criteria_volume_enabled = $7, criteria_volatility_enabled = $8 WHERE id = 1`,
      [next.enabled, next.startCapitalEur, next.numSlots, next.leverage, next.watchedSymbols, next.criteriaTrendEnabled, next.criteriaVolumeEnabled, next.criteriaVolatilityEnabled]
    );
    if (next.enabled && !wasEnabled) runScalpTradingCycle();
    res.json({ ok: true, settings: next, leverageWarning });
  } catch (err) {
    console.error('Scalping Bot: settings-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/scalp-trading/reset', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Scalping Bot nicht verfügbar.' });
  try {
    const settings = await getScalpSettings();
    await pgPool.query('DELETE FROM scalp_trades');
    await pgPool.query('DELETE FROM scalp_balance_history');
    await pgPool.query('DELETE FROM scalp_skipped_setups');
    await pgPool.query('DELETE FROM scalp_check_log');
    await pgPool.query('UPDATE scalp_settings SET balance_eur = $1, last_check = NULL WHERE id = 1', [settings.startCapitalEur]);
    await pgPool.query('INSERT INTO scalp_balance_history (balance) VALUES ($1)', [settings.startCapitalEur]);
    Object.keys(scalpLastPrices).forEach(k => delete scalpLastPrices[k]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Scalping Bot: reset-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/scalp-trading/close/:id', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Scalping Bot nicht verfügbar.' });
  try {
    const { rows } = await pgPool.query("SELECT * FROM scalp_trades WHERE id = $1 AND status = 'open'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Offener Trade nicht gefunden.' });
    const trade = scalpRowToTrade(rows[0]);

    let exitPrice, usedLastKnownPrice = false;
    try {
      exitPrice = await fetchLiveTickerPriceWithRetry(trade.symbol);
    } catch (err) {
      const cached = scalpLastPrices[trade.symbol];
      if (cached == null) {
        return res.status(503).json({ error: `Aktueller Kurs für ${trade.symbol} nicht abrufbar (${err.message}) und kein zwischengespeicherter Preis vorhanden. Bitte später erneut versuchen.` });
      }
      exitPrice = cached;
      usedLastKnownPrice = true;
    }

    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;

    await pgPool.query(
      `UPDATE scalp_trades SET status = 'closed', exit_price = $1, close_reason = 'MANUAL', pnl_eur = $2, closed_at = now() WHERE id = $3`,
      [exitPrice, pnlEur, trade.id]
    );
    const { rows: balRows } = await pgPool.query(
      'UPDATE scalp_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur',
      [pnlEur]
    );
    await pgPool.query('INSERT INTO scalp_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);

    res.json({ ok: true, exitPrice, pnlEur, usedLastKnownPrice });
  } catch (err) {
    console.error('Scalping Bot: manuelles Schließen fehlgeschlagen:', err);
    res.status(500).json({ error: err.message || 'Fehler beim Schließen.' });
  }
});

// ============================================================
// FVG BOT - vierter, komplett unabhängiger Paper-Trading-Bot
// (eigene Strategie, eigener Kapitalschutz, eigene DB-Tabellen "fvg_*").
//
// SICHERHEIT: Wie bei den anderen Bots - liest ausschließlich öffentliche
// Binance-Kursdaten, verändert nur lokal simulierte Werte. NUR SIMULATION.
//
// STRATEGIE "Fair Value Gap" auf 5-Minuten-Basis:
// 1) 3-Kerzen-FVG: bullisch wenn Hoch(K1) < Tief(K3), bearisch gespiegelt.
// 2) Kehrt der Kurs innerhalb von 20 Kerzen wieder in die Gap-Zone zurück,
//    wird ein Trade in Richtung der ursprünglichen Gap-Bewegung eröffnet
//    (bullische Gap -> Long, bearische Gap -> Short).
// 3) SL an der GEGENÜBERLIEGENDEN (fernen) Kante der Gap-Zone (vom Nutzer
//    im Chat explizit bestätigt, da die Formulierung im Auftrag intern
//    widersprüchlich war), Mindestabstand 0,15%. TP = konfigurierbares
//    RR-Verhältnis (Standard 1:3).
// ============================================================
const FVG_DEFAULT_SETTINGS = { enabled: false, startCapitalEur: 100, numSlots: 5, leverage: 5, riskRewardRatio: 3 };

async function initFvgTradingSchema() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS fvg_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      start_capital_eur NUMERIC NOT NULL DEFAULT 100,
      num_slots INTEGER NOT NULL DEFAULT 5,
      leverage INTEGER NOT NULL DEFAULT 5,
      risk_reward_ratio NUMERIC NOT NULL DEFAULT 3,
      balance_eur NUMERIC NOT NULL DEFAULT 100,
      watched_symbols TEXT[] NOT NULL DEFAULT ARRAY['BTCUSDT','ETHUSDT','SOLUSDT'],
      last_check TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS fvg_trades (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      stop_loss NUMERIC NOT NULL,
      take_profit NUMERIC NOT NULL,
      gap_low NUMERIC NOT NULL,
      gap_high NUMERIC NOT NULL,
      margin_eur NUMERIC NOT NULL,
      position_size_eur NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL,
      exit_price NUMERIC,
      close_reason TEXT,
      pnl_eur NUMERIC,
      closed_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS fvg_balance_history (
      id SERIAL PRIMARY KEY, time TIMESTAMPTZ NOT NULL DEFAULT now(), balance NUMERIC NOT NULL
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS fvg_skipped_setups (
      id UUID PRIMARY KEY, symbol TEXT NOT NULL, direction TEXT NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const { rows } = await pgPool.query('SELECT id FROM fvg_settings WHERE id = 1');
  if (!rows.length) {
    await pgPool.query(
      `INSERT INTO fvg_settings (id, enabled, start_capital_eur, num_slots, leverage, risk_reward_ratio, balance_eur, watched_symbols)
       VALUES (1, false, $1, $2, $3, $4, $1, $5)`,
      [FVG_DEFAULT_SETTINGS.startCapitalEur, FVG_DEFAULT_SETTINGS.numSlots, FVG_DEFAULT_SETTINGS.leverage, FVG_DEFAULT_SETTINGS.riskRewardRatio,
       ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT']]
    );
    await pgPool.query('INSERT INTO fvg_balance_history (balance) VALUES ($1)', [FVG_DEFAULT_SETTINGS.startCapitalEur]);
  }
}

function fvgRowToSettings(row) {
  return {
    enabled: row.enabled, startCapitalEur: Number(row.start_capital_eur), numSlots: Number(row.num_slots),
    leverage: Number(row.leverage), riskRewardRatio: Number(row.risk_reward_ratio), balanceEur: Number(row.balance_eur),
    watchedSymbols: row.watched_symbols, lastCheck: row.last_check ? new Date(row.last_check).getTime() : null
  };
}
async function getFvgSettings() {
  const { rows } = await pgPool.query('SELECT * FROM fvg_settings WHERE id = 1');
  return fvgRowToSettings(rows[0]);
}
function fvgRowToTrade(row) {
  return {
    id: row.id, symbol: row.symbol, direction: row.direction, entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss), takeProfit: Number(row.take_profit),
    gapLow: Number(row.gap_low), gapHigh: Number(row.gap_high),
    marginEur: Number(row.margin_eur), positionSizeEur: Number(row.position_size_eur), leverage: Number(row.leverage),
    reason: row.reason, openedAt: new Date(row.opened_at).getTime(),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null, closeReason: row.close_reason,
    pnlEur: row.pnl_eur != null ? Number(row.pnl_eur) : null, closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null
  };
}

const fvgLastPrices = {};

// Findet alle 3-Kerzen-FVG-Zonen in der Historie (ohne die letzte Kerze,
// die als potenzielle Revisit-Kerze separat geprüft wird).
function findFvgZones(candles) {
  const zones = [];
  for (let i = 2; i < candles.length; i++) {
    const k1 = candles[i - 2], k3 = candles[i];
    if (k1.high < k3.low) {
      zones.push({ type: 'bullish', gapLow: k1.high, gapHigh: k3.low, formedAtIndex: i });
    } else if (k1.low > k3.high) {
      zones.push({ type: 'bearish', gapLow: k3.high, gapHigh: k1.low, formedAtIndex: i });
    }
  }
  return zones;
}

// Vereinfachte Heuristik. Feuert nur beim ERSTEN Berühren der Zone (die
// vorherige Kerze durfte die Zone noch nicht berührt haben), damit nicht
// jeden Zyklus erneut derselbe Revisit ausgelöst wird.
function detectFvgSetup(candles) {
  const n = candles.length;
  if (n < 25) return null;
  const zones = findFvgZones(candles.slice(0, n - 1));
  const last = candles[n - 1];
  const prev = candles[n - 2];

  for (const zone of zones) {
    const age = (n - 1) - zone.formedAtIndex;
    if (age > 20 || age < 1) continue;
    const touchesNow = last.low <= zone.gapHigh && last.high >= zone.gapLow;
    const touchedBefore = prev.low <= zone.gapHigh && prev.high >= zone.gapLow;
    if (touchesNow && !touchedBefore) {
      return {
        direction: zone.type === 'bullish' ? 'long' : 'short',
        gapLow: zone.gapLow, gapHigh: zone.gapHigh, entryPrice: last.close
      };
    }
  }
  return null;
}

function computeFvgSlTp(direction, entryPrice, gapLow, gapHigh, riskReward) {
  const bufferPct = 0.001, minDistPct = 0.0015;
  let stopLoss = direction === 'long' ? gapLow * (1 - bufferPct) : gapHigh * (1 + bufferPct);
  const distPct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (distPct < minDistPct) stopLoss = direction === 'long' ? entryPrice * (1 - minDistPct) : entryPrice * (1 + minDistPct);
  const distance = Math.abs(entryPrice - stopLoss);
  const takeProfit = direction === 'long' ? entryPrice + distance * riskReward : entryPrice - distance * riskReward;
  return { stopLoss, takeProfit };
}

async function checkFvgSymbol(symbol, settings) {
  const candles = await fetchPaperCandles(symbol, '5m', 200);
  const lastPrice = candles[candles.length - 1].close;
  fvgLastPrices[symbol] = lastPrice;

  const { rows: openRows } = await pgPool.query("SELECT * FROM fvg_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  for (const row of openRows) {
    const trade = fvgRowToTrade(row);
    let closeReason = null;
    if (trade.direction === 'long') {
      if (lastPrice >= trade.takeProfit) closeReason = 'TP'; else if (lastPrice <= trade.stopLoss) closeReason = 'SL';
    } else {
      if (lastPrice <= trade.takeProfit) closeReason = 'TP'; else if (lastPrice >= trade.stopLoss) closeReason = 'SL';
    }
    if (!closeReason) continue;
    const exitPrice = lastPrice;
    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;
    await pgPool.query(`UPDATE fvg_trades SET status = 'closed', exit_price = $1, close_reason = $2, pnl_eur = $3, closed_at = now() WHERE id = $4`, [exitPrice, closeReason, pnlEur, trade.id]);
    const { rows: balRows } = await pgPool.query('UPDATE fvg_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur', [pnlEur]);
    await pgPool.query('INSERT INTO fvg_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);
  }

  const { rows: stillOpen } = await pgPool.query("SELECT COUNT(*)::int AS c FROM fvg_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  if (stillOpen[0].c > 0) return;

  const setup = detectFvgSetup(candles);
  if (!setup) return;

  const plan = computeFvgSlTp(setup.direction, setup.entryPrice, setup.gapLow, setup.gapHigh, settings.riskRewardRatio);
  const marginEur = settings.startCapitalEur / settings.numSlots;
  const { rows: usedRows } = await pgPool.query("SELECT COALESCE(SUM(margin_eur), 0) AS used FROM fvg_trades WHERE status = 'open'");
  const usedMarginEur = Number(usedRows[0].used);

  const reasonText = `${setup.direction === 'long' ? 'Bullisches' : 'Bearisches'} FVG (${setup.gapLow.toFixed(4)} - ${setup.gapHigh.toFixed(4)}), Revisit bei ${setup.entryPrice.toFixed(4)}.`;

  if (usedMarginEur + marginEur > settings.balanceEur) {
    await pgPool.query('INSERT INTO fvg_skipped_setups (id, symbol, direction, reason) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), symbol, setup.direction, `Kein freier Slot verfügbar (Margin ${marginEur.toFixed(2)}€ würde die Balance überschreiten). ${reasonText}`]);
    return;
  }

  const positionSizeEur = marginEur * settings.leverage;
  await pgPool.query(
    `INSERT INTO fvg_trades (id, symbol, direction, entry_price, stop_loss, take_profit, gap_low, gap_high, margin_eur, position_size_eur, leverage, reason, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open', now())`,
    [crypto.randomUUID(), symbol, setup.direction, setup.entryPrice, plan.stopLoss, plan.takeProfit, setup.gapLow, setup.gapHigh, marginEur, positionSizeEur, settings.leverage, reasonText]
  );
}

async function runFvgTradingCycle() {
  if (!pgPool) return;
  const settings = await getFvgSettings();
  if (!settings.enabled) return;
  for (const symbol of settings.watchedSymbols) {
    try { await checkFvgSymbol(symbol, settings); } catch (err) { console.error(`FVG-Bot-Fehler bei ${symbol}:`, err.message || err); }
    await sleep(150);
  }
  await pgPool.query('UPDATE fvg_settings SET last_check = now() WHERE id = 1');
}

const FVG_CHECK_INTERVAL_MS = 150 * 1000; // 2,5 Minuten (Vorgabe: 2-3 Min)
setInterval(runFvgTradingCycle, FVG_CHECK_INTERVAL_MS);

app.get('/api/fvg-trading/state', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - FVG Bot nicht verfügbar.' });
  try {
    const settings = await getFvgSettings();
    const { rows: openRows } = await pgPool.query("SELECT * FROM fvg_trades WHERE status = 'open' ORDER BY opened_at DESC");
    const { rows: closedRows } = await pgPool.query("SELECT * FROM fvg_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
    const { rows: historyRows } = await pgPool.query('SELECT time, balance FROM fvg_balance_history ORDER BY time ASC');
    const { rows: skippedRows } = await pgPool.query('SELECT * FROM fvg_skipped_setups ORDER BY created_at DESC LIMIT 50');

    const openTrades = openRows.map(fvgRowToTrade).map(t => {
      const currentPrice = fvgLastPrices[t.symbol] ?? null;
      let unrealizedPnlEur = null;
      if (currentPrice != null) {
        unrealizedPnlEur = t.direction === 'long'
          ? (currentPrice - t.entryPrice) / t.entryPrice * t.positionSizeEur
          : (t.entryPrice - currentPrice) / t.entryPrice * t.positionSizeEur;
      }
      return { ...t, currentPrice, unrealizedPnlEur };
    });
    const closedTrades = closedRows.map(fvgRowToTrade);
    const balanceHistory = historyRows.map(r => ({ time: new Date(r.time).getTime(), balance: Number(r.balance) }));
    const skippedSetups = skippedRows.map(r => ({ id: r.id, symbol: r.symbol, direction: r.direction, reason: r.reason, createdAt: new Date(r.created_at).getTime() }));

    res.json({ settings, balanceEur: settings.balanceEur, balanceHistory, openTrades, closedTrades, skippedSetups, lastCheck: settings.lastCheck, checkIntervalMs: FVG_CHECK_INTERVAL_MS });
  } catch (err) {
    console.error('FVG Bot: state-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/fvg-trading/settings', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - FVG Bot nicht verfügbar.' });
  try {
    const incoming = req.body || {};
    const current = await getFvgSettings();
    const wasEnabled = current.enabled;
    const next = {
      enabled: !!incoming.enabled,
      startCapitalEur: Number(incoming.startCapitalEur) > 0 ? Number(incoming.startCapitalEur) : current.startCapitalEur,
      numSlots: Number(incoming.numSlots) >= 1 ? Math.round(Number(incoming.numSlots)) : current.numSlots,
      leverage: Number(incoming.leverage) >= 1 && Number(incoming.leverage) <= 10 ? Math.round(Number(incoming.leverage)) : current.leverage,
      riskRewardRatio: Number(incoming.riskRewardRatio) > 0 ? Number(incoming.riskRewardRatio) : current.riskRewardRatio,
      watchedSymbols: Array.isArray(incoming.watchedSymbols) && incoming.watchedSymbols.length ? incoming.watchedSymbols : current.watchedSymbols
    };
    const leverageWarning = await checkLeverageChangeWarning('fvg_trades', current.leverage, next.leverage);

    await pgPool.query(
      `UPDATE fvg_settings SET enabled = $1, start_capital_eur = $2, num_slots = $3, leverage = $4, risk_reward_ratio = $5, watched_symbols = $6 WHERE id = 1`,
      [next.enabled, next.startCapitalEur, next.numSlots, next.leverage, next.riskRewardRatio, next.watchedSymbols]
    );
    if (next.enabled && !wasEnabled) runFvgTradingCycle();
    res.json({ ok: true, settings: next, leverageWarning });
  } catch (err) {
    console.error('FVG Bot: settings-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/fvg-trading/reset', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - FVG Bot nicht verfügbar.' });
  try {
    const settings = await getFvgSettings();
    await pgPool.query('DELETE FROM fvg_trades');
    await pgPool.query('DELETE FROM fvg_balance_history');
    await pgPool.query('DELETE FROM fvg_skipped_setups');
    await pgPool.query('UPDATE fvg_settings SET balance_eur = $1, last_check = NULL WHERE id = 1', [settings.startCapitalEur]);
    await pgPool.query('INSERT INTO fvg_balance_history (balance) VALUES ($1)', [settings.startCapitalEur]);
    Object.keys(fvgLastPrices).forEach(k => delete fvgLastPrices[k]);
    res.json({ ok: true });
  } catch (err) {
    console.error('FVG Bot: reset-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/fvg-trading/close/:id', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - FVG Bot nicht verfügbar.' });
  try {
    const { rows } = await pgPool.query("SELECT * FROM fvg_trades WHERE id = $1 AND status = 'open'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Offener Trade nicht gefunden.' });
    const trade = fvgRowToTrade(rows[0]);

    let exitPrice, usedLastKnownPrice = false;
    try {
      exitPrice = await fetchLiveTickerPriceWithRetry(trade.symbol);
    } catch (err) {
      const cached = fvgLastPrices[trade.symbol];
      if (cached == null) return res.status(503).json({ error: `Aktueller Kurs für ${trade.symbol} nicht abrufbar (${err.message}) und kein zwischengespeicherter Preis vorhanden. Bitte später erneut versuchen.` });
      exitPrice = cached;
      usedLastKnownPrice = true;
    }

    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;

    await pgPool.query(`UPDATE fvg_trades SET status = 'closed', exit_price = $1, close_reason = 'MANUAL', pnl_eur = $2, closed_at = now() WHERE id = $3`, [exitPrice, pnlEur, trade.id]);
    const { rows: balRows } = await pgPool.query('UPDATE fvg_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur', [pnlEur]);
    await pgPool.query('INSERT INTO fvg_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);

    res.json({ ok: true, exitPrice, pnlEur, usedLastKnownPrice });
  } catch (err) {
    console.error('FVG Bot: manuelles Schließen fehlgeschlagen:', err);
    res.status(500).json({ error: err.message || 'Fehler beim Schließen.' });
  }
});

// ============================================================
// CANDLESTICK BOT - fünfter, komplett unabhängiger Paper-Trading-Bot
// (eigene Strategie, eigener Kapitalschutz, eigene DB-Tabellen "candle_*").
//
// SICHERHEIT: Wie bei den anderen Bots - liest ausschließlich öffentliche
// Binance-Kursdaten, verändert nur lokal simulierte Werte. NUR SIMULATION.
//
// STRATEGIE "Kerzenmuster" auf 5-Minuten-Basis:
// Bullish Engulfing / Hammer nach vorherigem Abwärtskontext -> Long.
// Bearish Engulfing / Shooting Star nach vorherigem Aufwärtskontext -> Short.
// SL knapp hinter dem Extrempunkt der Signalkerze, Mindestabstand 0,15%.
// TP = konfigurierbares RR-Verhältnis (Standard 1:3).
// ============================================================
const CANDLE_DEFAULT_SETTINGS = { enabled: false, startCapitalEur: 100, numSlots: 5, leverage: 5, riskRewardRatio: 3 };

async function initCandleTradingSchema() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS candle_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      start_capital_eur NUMERIC NOT NULL DEFAULT 100,
      num_slots INTEGER NOT NULL DEFAULT 5,
      leverage INTEGER NOT NULL DEFAULT 5,
      risk_reward_ratio NUMERIC NOT NULL DEFAULT 3,
      balance_eur NUMERIC NOT NULL DEFAULT 100,
      watched_symbols TEXT[] NOT NULL DEFAULT ARRAY['BTCUSDT','ETHUSDT','SOLUSDT'],
      last_check TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS candle_trades (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      stop_loss NUMERIC NOT NULL,
      take_profit NUMERIC NOT NULL,
      pattern TEXT NOT NULL,
      signal_extreme NUMERIC NOT NULL,
      margin_eur NUMERIC NOT NULL,
      position_size_eur NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL,
      exit_price NUMERIC,
      close_reason TEXT,
      pnl_eur NUMERIC,
      closed_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS candle_balance_history (
      id SERIAL PRIMARY KEY, time TIMESTAMPTZ NOT NULL DEFAULT now(), balance NUMERIC NOT NULL
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS candle_skipped_setups (
      id UUID PRIMARY KEY, symbol TEXT NOT NULL, direction TEXT NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const { rows } = await pgPool.query('SELECT id FROM candle_settings WHERE id = 1');
  if (!rows.length) {
    await pgPool.query(
      `INSERT INTO candle_settings (id, enabled, start_capital_eur, num_slots, leverage, risk_reward_ratio, balance_eur, watched_symbols)
       VALUES (1, false, $1, $2, $3, $4, $1, $5)`,
      [CANDLE_DEFAULT_SETTINGS.startCapitalEur, CANDLE_DEFAULT_SETTINGS.numSlots, CANDLE_DEFAULT_SETTINGS.leverage, CANDLE_DEFAULT_SETTINGS.riskRewardRatio,
       ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT']]
    );
    await pgPool.query('INSERT INTO candle_balance_history (balance) VALUES ($1)', [CANDLE_DEFAULT_SETTINGS.startCapitalEur]);
  }
}

function candleRowToSettings(row) {
  return {
    enabled: row.enabled, startCapitalEur: Number(row.start_capital_eur), numSlots: Number(row.num_slots),
    leverage: Number(row.leverage), riskRewardRatio: Number(row.risk_reward_ratio), balanceEur: Number(row.balance_eur),
    watchedSymbols: row.watched_symbols, lastCheck: row.last_check ? new Date(row.last_check).getTime() : null
  };
}
async function getCandleSettings() {
  const { rows } = await pgPool.query('SELECT * FROM candle_settings WHERE id = 1');
  return candleRowToSettings(rows[0]);
}
function candleRowToTrade(row) {
  return {
    id: row.id, symbol: row.symbol, direction: row.direction, entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss), takeProfit: Number(row.take_profit),
    pattern: row.pattern, signalExtreme: Number(row.signal_extreme),
    marginEur: Number(row.margin_eur), positionSizeEur: Number(row.position_size_eur), leverage: Number(row.leverage),
    reason: row.reason, openedAt: new Date(row.opened_at).getTime(),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null, closeReason: row.close_reason,
    pnlEur: row.pnl_eur != null ? Number(row.pnl_eur) : null, closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null
  };
}

const candleLastPrices = {};

function isBullishEngulfing(k1, k2) {
  return k1.close < k1.open && k2.close > k2.open && k2.close > k1.open && k2.open < k1.close;
}
function isBearishEngulfing(k1, k2) {
  return k1.close > k1.open && k2.close < k2.open && k2.close < k1.open && k2.open > k1.close;
}
function isHammer(c) {
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  return body > 0 && lowerWick >= body * 2 && upperWick <= body * 0.5;
}
function isShootingStar(c) {
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return body > 0 && upperWick >= body * 2 && lowerWick <= body * 0.5;
}

// Zusatzbedingung: mind. 2 rote Kerzen direkt davor ODER fallender SMA10
// (Abwärtskontext für Long-Signale; gespiegelt für Short).
function priorTrendDown(candles, idx) {
  if (idx < 3) return false;
  const redRun = candles[idx - 1].close < candles[idx - 1].open && candles[idx - 2].close < candles[idx - 2].open;
  if (redRun) return true;
  if (idx < 11) return false;
  const sma = start => candles.slice(start, start + 10).reduce((s, c) => s + c.close, 0) / 10;
  return sma(idx - 10) < sma(idx - 11);
}
function priorTrendUp(candles, idx) {
  if (idx < 3) return false;
  const greenRun = candles[idx - 1].close > candles[idx - 1].open && candles[idx - 2].close > candles[idx - 2].open;
  if (greenRun) return true;
  if (idx < 11) return false;
  const sma = start => candles.slice(start, start + 10).reduce((s, c) => s + c.close, 0) / 10;
  return sma(idx - 10) > sma(idx - 11);
}

// Vereinfachte Heuristik, keine Garantie für korrekte Mustererkennung.
function detectCandleSetup(candles) {
  const n = candles.length;
  if (n < 15) return null;
  const k2 = candles[n - 1], k1 = candles[n - 2];

  if (priorTrendDown(candles, n - 1) && isBullishEngulfing(k1, k2)) {
    return { direction: 'long', pattern: 'Bullish Engulfing', signalExtreme: k2.low, entryPrice: k2.close };
  }
  if (priorTrendDown(candles, n - 1) && isHammer(k2)) {
    return { direction: 'long', pattern: 'Hammer', signalExtreme: k2.low, entryPrice: k2.close };
  }
  if (priorTrendUp(candles, n - 1) && isBearishEngulfing(k1, k2)) {
    return { direction: 'short', pattern: 'Bearish Engulfing', signalExtreme: k2.high, entryPrice: k2.close };
  }
  if (priorTrendUp(candles, n - 1) && isShootingStar(k2)) {
    return { direction: 'short', pattern: 'Shooting Star', signalExtreme: k2.high, entryPrice: k2.close };
  }
  return null;
}

function computeCandleSlTp(direction, entryPrice, signalExtreme, riskReward) {
  const bufferPct = 0.001, minDistPct = 0.0015;
  let stopLoss = direction === 'long' ? signalExtreme * (1 - bufferPct) : signalExtreme * (1 + bufferPct);
  const distPct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (distPct < minDistPct) stopLoss = direction === 'long' ? entryPrice * (1 - minDistPct) : entryPrice * (1 + minDistPct);
  const distance = Math.abs(entryPrice - stopLoss);
  const takeProfit = direction === 'long' ? entryPrice + distance * riskReward : entryPrice - distance * riskReward;
  return { stopLoss, takeProfit };
}

async function checkCandleSymbol(symbol, settings) {
  const candles = await fetchPaperCandles(symbol, '5m', 200);
  const lastPrice = candles[candles.length - 1].close;
  candleLastPrices[symbol] = lastPrice;

  const { rows: openRows } = await pgPool.query("SELECT * FROM candle_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  for (const row of openRows) {
    const trade = candleRowToTrade(row);
    let closeReason = null;
    if (trade.direction === 'long') {
      if (lastPrice >= trade.takeProfit) closeReason = 'TP'; else if (lastPrice <= trade.stopLoss) closeReason = 'SL';
    } else {
      if (lastPrice <= trade.takeProfit) closeReason = 'TP'; else if (lastPrice >= trade.stopLoss) closeReason = 'SL';
    }
    if (!closeReason) continue;
    const exitPrice = lastPrice;
    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;
    await pgPool.query(`UPDATE candle_trades SET status = 'closed', exit_price = $1, close_reason = $2, pnl_eur = $3, closed_at = now() WHERE id = $4`, [exitPrice, closeReason, pnlEur, trade.id]);
    const { rows: balRows } = await pgPool.query('UPDATE candle_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur', [pnlEur]);
    await pgPool.query('INSERT INTO candle_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);
  }

  const { rows: stillOpen } = await pgPool.query("SELECT COUNT(*)::int AS c FROM candle_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  if (stillOpen[0].c > 0) return;

  const setup = detectCandleSetup(candles);
  if (!setup) return;

  const plan = computeCandleSlTp(setup.direction, setup.entryPrice, setup.signalExtreme, settings.riskRewardRatio);
  const marginEur = settings.startCapitalEur / settings.numSlots;
  const { rows: usedRows } = await pgPool.query("SELECT COALESCE(SUM(margin_eur), 0) AS used FROM candle_trades WHERE status = 'open'");
  const usedMarginEur = Number(usedRows[0].used);

  const reasonText = `${setup.pattern} erkannt (Signalkerze Extrempunkt ${setup.signalExtreme.toFixed(4)}), Einstieg bei ${setup.entryPrice.toFixed(4)}.`;

  if (usedMarginEur + marginEur > settings.balanceEur) {
    await pgPool.query('INSERT INTO candle_skipped_setups (id, symbol, direction, reason) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), symbol, setup.direction, `Kein freier Slot verfügbar (Margin ${marginEur.toFixed(2)}€ würde die Balance überschreiten). ${reasonText}`]);
    return;
  }

  const positionSizeEur = marginEur * settings.leverage;
  await pgPool.query(
    `INSERT INTO candle_trades (id, symbol, direction, entry_price, stop_loss, take_profit, pattern, signal_extreme, margin_eur, position_size_eur, leverage, reason, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open', now())`,
    [crypto.randomUUID(), symbol, setup.direction, setup.entryPrice, plan.stopLoss, plan.takeProfit, setup.pattern, setup.signalExtreme, marginEur, positionSizeEur, settings.leverage, reasonText]
  );
}

async function runCandleTradingCycle() {
  if (!pgPool) return;
  const settings = await getCandleSettings();
  if (!settings.enabled) return;
  for (const symbol of settings.watchedSymbols) {
    try { await checkCandleSymbol(symbol, settings); } catch (err) { console.error(`Candlestick-Bot-Fehler bei ${symbol}:`, err.message || err); }
    await sleep(150);
  }
  await pgPool.query('UPDATE candle_settings SET last_check = now() WHERE id = 1');
}

const CANDLE_CHECK_INTERVAL_MS = 150 * 1000; // 2,5 Minuten (Vorgabe: 2-3 Min)
setInterval(runCandleTradingCycle, CANDLE_CHECK_INTERVAL_MS);

app.get('/api/candle-trading/state', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Candlestick Bot nicht verfügbar.' });
  try {
    const settings = await getCandleSettings();
    const { rows: openRows } = await pgPool.query("SELECT * FROM candle_trades WHERE status = 'open' ORDER BY opened_at DESC");
    const { rows: closedRows } = await pgPool.query("SELECT * FROM candle_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
    const { rows: historyRows } = await pgPool.query('SELECT time, balance FROM candle_balance_history ORDER BY time ASC');
    const { rows: skippedRows } = await pgPool.query('SELECT * FROM candle_skipped_setups ORDER BY created_at DESC LIMIT 50');

    const openTrades = openRows.map(candleRowToTrade).map(t => {
      const currentPrice = candleLastPrices[t.symbol] ?? null;
      let unrealizedPnlEur = null;
      if (currentPrice != null) {
        unrealizedPnlEur = t.direction === 'long'
          ? (currentPrice - t.entryPrice) / t.entryPrice * t.positionSizeEur
          : (t.entryPrice - currentPrice) / t.entryPrice * t.positionSizeEur;
      }
      return { ...t, currentPrice, unrealizedPnlEur };
    });
    const closedTrades = closedRows.map(candleRowToTrade);
    const balanceHistory = historyRows.map(r => ({ time: new Date(r.time).getTime(), balance: Number(r.balance) }));
    const skippedSetups = skippedRows.map(r => ({ id: r.id, symbol: r.symbol, direction: r.direction, reason: r.reason, createdAt: new Date(r.created_at).getTime() }));

    res.json({ settings, balanceEur: settings.balanceEur, balanceHistory, openTrades, closedTrades, skippedSetups, lastCheck: settings.lastCheck, checkIntervalMs: CANDLE_CHECK_INTERVAL_MS });
  } catch (err) {
    console.error('Candlestick Bot: state-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/candle-trading/settings', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Candlestick Bot nicht verfügbar.' });
  try {
    const incoming = req.body || {};
    const current = await getCandleSettings();
    const wasEnabled = current.enabled;
    const next = {
      enabled: !!incoming.enabled,
      startCapitalEur: Number(incoming.startCapitalEur) > 0 ? Number(incoming.startCapitalEur) : current.startCapitalEur,
      numSlots: Number(incoming.numSlots) >= 1 ? Math.round(Number(incoming.numSlots)) : current.numSlots,
      leverage: Number(incoming.leverage) >= 1 && Number(incoming.leverage) <= 10 ? Math.round(Number(incoming.leverage)) : current.leverage,
      riskRewardRatio: Number(incoming.riskRewardRatio) > 0 ? Number(incoming.riskRewardRatio) : current.riskRewardRatio,
      watchedSymbols: Array.isArray(incoming.watchedSymbols) && incoming.watchedSymbols.length ? incoming.watchedSymbols : current.watchedSymbols
    };
    const leverageWarning = await checkLeverageChangeWarning('candle_trades', current.leverage, next.leverage);

    await pgPool.query(
      `UPDATE candle_settings SET enabled = $1, start_capital_eur = $2, num_slots = $3, leverage = $4, risk_reward_ratio = $5, watched_symbols = $6 WHERE id = 1`,
      [next.enabled, next.startCapitalEur, next.numSlots, next.leverage, next.riskRewardRatio, next.watchedSymbols]
    );
    if (next.enabled && !wasEnabled) runCandleTradingCycle();
    res.json({ ok: true, settings: next, leverageWarning });
  } catch (err) {
    console.error('Candlestick Bot: settings-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/candle-trading/reset', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Candlestick Bot nicht verfügbar.' });
  try {
    const settings = await getCandleSettings();
    await pgPool.query('DELETE FROM candle_trades');
    await pgPool.query('DELETE FROM candle_balance_history');
    await pgPool.query('DELETE FROM candle_skipped_setups');
    await pgPool.query('UPDATE candle_settings SET balance_eur = $1, last_check = NULL WHERE id = 1', [settings.startCapitalEur]);
    await pgPool.query('INSERT INTO candle_balance_history (balance) VALUES ($1)', [settings.startCapitalEur]);
    Object.keys(candleLastPrices).forEach(k => delete candleLastPrices[k]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Candlestick Bot: reset-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/candle-trading/close/:id', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Candlestick Bot nicht verfügbar.' });
  try {
    const { rows } = await pgPool.query("SELECT * FROM candle_trades WHERE id = $1 AND status = 'open'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Offener Trade nicht gefunden.' });
    const trade = candleRowToTrade(rows[0]);

    let exitPrice, usedLastKnownPrice = false;
    try {
      exitPrice = await fetchLiveTickerPriceWithRetry(trade.symbol);
    } catch (err) {
      const cached = candleLastPrices[trade.symbol];
      if (cached == null) return res.status(503).json({ error: `Aktueller Kurs für ${trade.symbol} nicht abrufbar (${err.message}) und kein zwischengespeicherter Preis vorhanden. Bitte später erneut versuchen.` });
      exitPrice = cached;
      usedLastKnownPrice = true;
    }

    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;

    await pgPool.query(`UPDATE candle_trades SET status = 'closed', exit_price = $1, close_reason = 'MANUAL', pnl_eur = $2, closed_at = now() WHERE id = $3`, [exitPrice, pnlEur, trade.id]);
    const { rows: balRows } = await pgPool.query('UPDATE candle_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur', [pnlEur]);
    await pgPool.query('INSERT INTO candle_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);

    res.json({ ok: true, exitPrice, pnlEur, usedLastKnownPrice });
  } catch (err) {
    console.error('Candlestick Bot: manuelles Schließen fehlgeschlagen:', err);
    res.status(500).json({ error: err.message || 'Fehler beim Schließen.' });
  }
});

// Gemeinsamer Hebel-Konsistenz-Check für ALLE Bots: warnt (blockiert
// nichts), wenn der Hebel geändert wird während bereits Trades existieren -
// das würde sonst zu Trades mit unterschiedlichem Hebel in derselben
// Auswertung führen (aufgefallen beim Scalping Bot).
async function checkLeverageChangeWarning(tradesTable, currentLeverage, newLeverage) {
  if (currentLeverage === newLeverage) return false;
  const { rows } = await pgPool.query(`SELECT COUNT(*)::int AS c FROM ${tradesTable}`);
  return rows[0].c > 0;
}

// Dynamische Nachkommastellen für Preis-Text (z.B. in Erkennungsgründen),
// damit sehr günstige Coins (z.B. SHIB im Bereich 0,000005) nicht auf
// "0.0000" gerundet werden.
function formatPriceDynamic(value) {
  const abs = Math.abs(value);
  const decimals = abs < 0.001 ? 8 : abs < 1 ? 6 : abs < 100 ? 4 : 2;
  return value.toFixed(decimals);
}

// ============================================================
// VWAP BOT - sechster, komplett unabhängiger Paper-Trading-Bot
// (eigene Strategie, eigener Kapitalschutz, eigene DB-Tabellen "vwap_*").
//
// SICHERHEIT: Wie bei den anderen Bots - liest ausschließlich öffentliche
// Binance-Kursdaten, verändert nur lokal simulierte Werte. NUR SIMULATION.
//
// STRATEGIE "VWAP Reversion" auf 5-Minuten-Basis:
// 1) Tages-VWAP (zurückgesetzt bei UTC-Mitternacht), kumulativ aus
//    typischem Preis (Hoch+Tief+Schluss)/3 gewichtet mit Volumen.
// 2) Kurs mindestens 1% vom VWAP entfernt (Standardwert, siehe Erklärung
//    im Chat - eine coin-relative Volatilitätsschwelle wäre technisch
//    aufwendiger und wurde nicht stillschweigend stattdessen gebaut).
// 3) Umkehrkerze (grün bei Long/rot bei Short) mit überdurchschnittlichem
//    Volumen (>Ø der letzten 10 Kerzen) während die Abweichung noch gilt.
// 4) SL am Extrempunkt der Abweichung, Mindestabstand 0,2%.
// 5) TP = Distanz zum VWAP, gedeckelt zwischen 2x und dem konfigurierbaren
//    RR-Verhältnis (Standard 2,5x) der SL-Distanz - siehe Erklärung im
//    Chat zur genauen Interpretation dieser Vorgabe.
// ============================================================
const VWAP_DEFAULT_SETTINGS = { enabled: false, startCapitalEur: 100, numSlots: 5, leverage: 10, riskRewardRatio: 2.5 };

async function initVwapTradingSchema() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS vwap_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      start_capital_eur NUMERIC NOT NULL DEFAULT 100,
      num_slots INTEGER NOT NULL DEFAULT 5,
      leverage INTEGER NOT NULL DEFAULT 10,
      risk_reward_ratio NUMERIC NOT NULL DEFAULT 2.5,
      balance_eur NUMERIC NOT NULL DEFAULT 100,
      watched_symbols TEXT[] NOT NULL DEFAULT ARRAY['BTCUSDT','ETHUSDT','SOLUSDT'],
      last_check TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS vwap_trades (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      stop_loss NUMERIC NOT NULL,
      take_profit NUMERIC NOT NULL,
      vwap_at_entry NUMERIC NOT NULL,
      deviation_extreme NUMERIC NOT NULL,
      margin_eur NUMERIC NOT NULL,
      position_size_eur NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL,
      exit_price NUMERIC,
      close_reason TEXT,
      pnl_eur NUMERIC,
      closed_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS vwap_balance_history (
      id SERIAL PRIMARY KEY, time TIMESTAMPTZ NOT NULL DEFAULT now(), balance NUMERIC NOT NULL
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS vwap_skipped_setups (
      id UUID PRIMARY KEY, symbol TEXT NOT NULL, direction TEXT NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const { rows } = await pgPool.query('SELECT id FROM vwap_settings WHERE id = 1');
  if (!rows.length) {
    await pgPool.query(
      `INSERT INTO vwap_settings (id, enabled, start_capital_eur, num_slots, leverage, risk_reward_ratio, balance_eur, watched_symbols)
       VALUES (1, false, $1, $2, $3, $4, $1, $5)`,
      [VWAP_DEFAULT_SETTINGS.startCapitalEur, VWAP_DEFAULT_SETTINGS.numSlots, VWAP_DEFAULT_SETTINGS.leverage, VWAP_DEFAULT_SETTINGS.riskRewardRatio,
       ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT']]
    );
    await pgPool.query('INSERT INTO vwap_balance_history (balance) VALUES ($1)', [VWAP_DEFAULT_SETTINGS.startCapitalEur]);
  }
}

function vwapRowToSettings(row) {
  return {
    enabled: row.enabled, startCapitalEur: Number(row.start_capital_eur), numSlots: Number(row.num_slots),
    leverage: Number(row.leverage), riskRewardRatio: Number(row.risk_reward_ratio), balanceEur: Number(row.balance_eur),
    watchedSymbols: row.watched_symbols, lastCheck: row.last_check ? new Date(row.last_check).getTime() : null
  };
}
async function getVwapSettings() {
  const { rows } = await pgPool.query('SELECT * FROM vwap_settings WHERE id = 1');
  return vwapRowToSettings(rows[0]);
}
function vwapRowToTrade(row) {
  return {
    id: row.id, symbol: row.symbol, direction: row.direction, entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss), takeProfit: Number(row.take_profit),
    vwapAtEntry: Number(row.vwap_at_entry), deviationExtreme: Number(row.deviation_extreme),
    marginEur: Number(row.margin_eur), positionSizeEur: Number(row.position_size_eur), leverage: Number(row.leverage),
    reason: row.reason, openedAt: new Date(row.opened_at).getTime(),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null, closeReason: row.close_reason,
    pnlEur: row.pnl_eur != null ? Number(row.pnl_eur) : null, closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null
  };
}

const vwapLastPrices = {};

// Kumulativer Tages-VWAP (zurückgesetzt bei jedem neuen UTC-Kalendertag).
function computeDailyVwapSeries(candles) {
  const out = new Array(candles.length).fill(null);
  let cumPV = 0, cumVol = 0, currentDay = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = new Date(c.time).toISOString().slice(0, 10);
    if (day !== currentDay) { currentDay = day; cumPV = 0; cumVol = 0; }
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumPV += typicalPrice * c.volume;
    cumVol += c.volume;
    out[i] = cumVol > 0 ? cumPV / cumVol : null;
  }
  return out;
}

// Vereinfachte Heuristik. 1%-Schwelle als fester Wert (siehe Erklärung
// im Chat - eine coin-relative Volatilitätsschwelle wäre eine größere,
// separate Änderung).
function detectVwapSetup(candles) {
  const n = candles.length;
  if (n < 15) return null;
  const vwapSeries = computeDailyVwapSeries(candles);
  const last = candles[n - 1];
  const vwapNow = vwapSeries[n - 1];
  if (vwapNow == null || vwapNow <= 0) return null;

  const deviationPct = (last.close - vwapNow) / vwapNow;
  const priorVolumes = candles.slice(Math.max(0, n - 11), n - 1).map(c => c.volume);
  const avgVolume = priorVolumes.length ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length : 0;
  const isGreen = last.close > last.open;
  const isRed = last.close < last.open;
  const highVolume = avgVolume > 0 && last.volume > avgVolume;

  if (deviationPct <= -0.01 && isGreen && highVolume) {
    let extreme = last.low;
    for (let i = n - 2; i >= 0 && vwapSeries[i] != null; i--) {
      if (candles[i].close >= vwapSeries[i]) break;
      extreme = Math.min(extreme, candles[i].low);
    }
    return { direction: 'long', vwap: vwapNow, extreme, entryPrice: last.close, deviationPct };
  }
  if (deviationPct >= 0.01 && isRed && highVolume) {
    let extreme = last.high;
    for (let i = n - 2; i >= 0 && vwapSeries[i] != null; i--) {
      if (candles[i].close <= vwapSeries[i]) break;
      extreme = Math.max(extreme, candles[i].high);
    }
    return { direction: 'short', vwap: vwapNow, extreme, entryPrice: last.close, deviationPct };
  }
  return null;
}

// TP-Interpretation (siehe Erklärung im Chat): der konfigurierbare
// RR-Wert (Standard 2,5) dient als OBERGRENZE für das Vielfache der
// SL-Distanz; die Untergrenze ist min(2, RR) - damit bleibt "mindestens
// 2x, höchstens RR-fach" konsistent, auch wenn RR frei geändert wird.
function computeVwapSlTp(direction, entryPrice, extreme, vwap, riskRewardCap) {
  const bufferPct = 0.001, minDistPct = 0.002;
  let stopLoss = direction === 'long' ? extreme * (1 - bufferPct) : extreme * (1 + bufferPct);
  const distPct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (distPct < minDistPct) stopLoss = direction === 'long' ? entryPrice * (1 - minDistPct) : entryPrice * (1 + minDistPct);
  const distance = Math.abs(entryPrice - stopLoss);

  const floorMultiple = Math.min(2, riskRewardCap);
  const capMultiple = Math.max(riskRewardCap, floorMultiple);
  const vwapDistance = Math.abs(vwap - entryPrice);
  let multiple = distance > 0 ? vwapDistance / distance : floorMultiple;
  multiple = Math.max(floorMultiple, Math.min(capMultiple, multiple));

  const takeProfit = direction === 'long' ? entryPrice + distance * multiple : entryPrice - distance * multiple;
  return { stopLoss, takeProfit };
}

async function checkVwapSymbol(symbol, settings) {
  const candles = await fetchPaperCandles(symbol, '5m', 288); // ~24h Historie für den Tages-VWAP
  const lastPrice = candles[candles.length - 1].close;
  vwapLastPrices[symbol] = lastPrice;

  const { rows: openRows } = await pgPool.query("SELECT * FROM vwap_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  for (const row of openRows) {
    const trade = vwapRowToTrade(row);
    let closeReason = null;
    if (trade.direction === 'long') {
      if (lastPrice >= trade.takeProfit) closeReason = 'TP'; else if (lastPrice <= trade.stopLoss) closeReason = 'SL';
    } else {
      if (lastPrice <= trade.takeProfit) closeReason = 'TP'; else if (lastPrice >= trade.stopLoss) closeReason = 'SL';
    }
    if (!closeReason) continue;
    const exitPrice = lastPrice;
    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;
    await pgPool.query(`UPDATE vwap_trades SET status = 'closed', exit_price = $1, close_reason = $2, pnl_eur = $3, closed_at = now() WHERE id = $4`, [exitPrice, closeReason, pnlEur, trade.id]);
    const { rows: balRows } = await pgPool.query('UPDATE vwap_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur', [pnlEur]);
    await pgPool.query('INSERT INTO vwap_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);
  }

  const { rows: stillOpen } = await pgPool.query("SELECT COUNT(*)::int AS c FROM vwap_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  if (stillOpen[0].c > 0) return;

  const setup = detectVwapSetup(candles);
  if (!setup) return;

  const plan = computeVwapSlTp(setup.direction, setup.entryPrice, setup.extreme, setup.vwap, settings.riskRewardRatio);
  const marginEur = settings.startCapitalEur / settings.numSlots;
  const { rows: usedRows } = await pgPool.query("SELECT COALESCE(SUM(margin_eur), 0) AS used FROM vwap_trades WHERE status = 'open'");
  const usedMarginEur = Number(usedRows[0].used);

  const reasonText = `Kurs ${(setup.deviationPct * 100).toFixed(2)}% ${setup.direction === 'long' ? 'unter' : 'über'} Tages-VWAP (${formatPriceDynamic(setup.vwap)}), Umkehrkerze mit überdurchschnittlichem Volumen bei ${formatPriceDynamic(setup.entryPrice)}. Extrempunkt der Abweichung: ${formatPriceDynamic(setup.extreme)}.`;

  if (usedMarginEur + marginEur > settings.balanceEur) {
    await pgPool.query('INSERT INTO vwap_skipped_setups (id, symbol, direction, reason) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), symbol, setup.direction, `Kein freier Slot verfügbar (Margin ${marginEur.toFixed(2)}€ würde die Balance überschreiten). ${reasonText}`]);
    return;
  }

  const positionSizeEur = marginEur * settings.leverage;
  await pgPool.query(
    `INSERT INTO vwap_trades (id, symbol, direction, entry_price, stop_loss, take_profit, vwap_at_entry, deviation_extreme, margin_eur, position_size_eur, leverage, reason, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open', now())`,
    [crypto.randomUUID(), symbol, setup.direction, setup.entryPrice, plan.stopLoss, plan.takeProfit, setup.vwap, setup.extreme, marginEur, positionSizeEur, settings.leverage, reasonText]
  );
}

async function runVwapTradingCycle() {
  if (!pgPool) return;
  const settings = await getVwapSettings();
  if (!settings.enabled) return;
  for (const symbol of settings.watchedSymbols) {
    try { await checkVwapSymbol(symbol, settings); } catch (err) { console.error(`VWAP-Bot-Fehler bei ${symbol}:`, err.message || err); }
    await sleep(150);
  }
  await pgPool.query('UPDATE vwap_settings SET last_check = now() WHERE id = 1');
}

const VWAP_CHECK_INTERVAL_MS = 150 * 1000; // 2,5 Minuten (Vorgabe: 2-3 Min)
setInterval(runVwapTradingCycle, VWAP_CHECK_INTERVAL_MS);

app.get('/api/vwap-trading/state', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - VWAP Bot nicht verfügbar.' });
  try {
    const settings = await getVwapSettings();
    const { rows: openRows } = await pgPool.query("SELECT * FROM vwap_trades WHERE status = 'open' ORDER BY opened_at DESC");
    const { rows: closedRows } = await pgPool.query("SELECT * FROM vwap_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
    const { rows: historyRows } = await pgPool.query('SELECT time, balance FROM vwap_balance_history ORDER BY time ASC');
    const { rows: skippedRows } = await pgPool.query('SELECT * FROM vwap_skipped_setups ORDER BY created_at DESC LIMIT 50');

    const openTrades = openRows.map(vwapRowToTrade).map(t => {
      const currentPrice = vwapLastPrices[t.symbol] ?? null;
      let unrealizedPnlEur = null;
      if (currentPrice != null) {
        unrealizedPnlEur = t.direction === 'long'
          ? (currentPrice - t.entryPrice) / t.entryPrice * t.positionSizeEur
          : (t.entryPrice - currentPrice) / t.entryPrice * t.positionSizeEur;
      }
      return { ...t, currentPrice, unrealizedPnlEur };
    });
    const closedTrades = closedRows.map(vwapRowToTrade);
    const balanceHistory = historyRows.map(r => ({ time: new Date(r.time).getTime(), balance: Number(r.balance) }));
    const skippedSetups = skippedRows.map(r => ({ id: r.id, symbol: r.symbol, direction: r.direction, reason: r.reason, createdAt: new Date(r.created_at).getTime() }));

    res.json({ settings, balanceEur: settings.balanceEur, balanceHistory, openTrades, closedTrades, skippedSetups, lastCheck: settings.lastCheck, checkIntervalMs: VWAP_CHECK_INTERVAL_MS });
  } catch (err) {
    console.error('VWAP Bot: state-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/vwap-trading/settings', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - VWAP Bot nicht verfügbar.' });
  try {
    const incoming = req.body || {};
    const current = await getVwapSettings();
    const wasEnabled = current.enabled;
    const next = {
      enabled: !!incoming.enabled,
      startCapitalEur: Number(incoming.startCapitalEur) > 0 ? Number(incoming.startCapitalEur) : current.startCapitalEur,
      numSlots: Number(incoming.numSlots) >= 1 ? Math.round(Number(incoming.numSlots)) : current.numSlots,
      leverage: Number(incoming.leverage) >= 1 && Number(incoming.leverage) <= 10 ? Math.round(Number(incoming.leverage)) : current.leverage,
      riskRewardRatio: Number(incoming.riskRewardRatio) > 0 ? Number(incoming.riskRewardRatio) : current.riskRewardRatio,
      watchedSymbols: Array.isArray(incoming.watchedSymbols) && incoming.watchedSymbols.length ? incoming.watchedSymbols : current.watchedSymbols
    };
    const leverageWarning = await checkLeverageChangeWarning('vwap_trades', current.leverage, next.leverage);

    await pgPool.query(
      `UPDATE vwap_settings SET enabled = $1, start_capital_eur = $2, num_slots = $3, leverage = $4, risk_reward_ratio = $5, watched_symbols = $6 WHERE id = 1`,
      [next.enabled, next.startCapitalEur, next.numSlots, next.leverage, next.riskRewardRatio, next.watchedSymbols]
    );
    if (next.enabled && !wasEnabled) runVwapTradingCycle();
    res.json({ ok: true, settings: next, leverageWarning });
  } catch (err) {
    console.error('VWAP Bot: settings-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/vwap-trading/reset', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - VWAP Bot nicht verfügbar.' });
  try {
    const settings = await getVwapSettings();
    await pgPool.query('DELETE FROM vwap_trades');
    await pgPool.query('DELETE FROM vwap_balance_history');
    await pgPool.query('DELETE FROM vwap_skipped_setups');
    await pgPool.query('UPDATE vwap_settings SET balance_eur = $1, last_check = NULL WHERE id = 1', [settings.startCapitalEur]);
    await pgPool.query('INSERT INTO vwap_balance_history (balance) VALUES ($1)', [settings.startCapitalEur]);
    Object.keys(vwapLastPrices).forEach(k => delete vwapLastPrices[k]);
    res.json({ ok: true });
  } catch (err) {
    console.error('VWAP Bot: reset-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/vwap-trading/close/:id', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - VWAP Bot nicht verfügbar.' });
  try {
    const { rows } = await pgPool.query("SELECT * FROM vwap_trades WHERE id = $1 AND status = 'open'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Offener Trade nicht gefunden.' });
    const trade = vwapRowToTrade(rows[0]);

    let exitPrice, usedLastKnownPrice = false;
    try {
      exitPrice = await fetchLiveTickerPriceWithRetry(trade.symbol);
    } catch (err) {
      const cached = vwapLastPrices[trade.symbol];
      if (cached == null) return res.status(503).json({ error: `Aktueller Kurs für ${trade.symbol} nicht abrufbar (${err.message}) und kein zwischengespeicherter Preis vorhanden. Bitte später erneut versuchen.` });
      exitPrice = cached;
      usedLastKnownPrice = true;
    }

    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;

    await pgPool.query(`UPDATE vwap_trades SET status = 'closed', exit_price = $1, close_reason = 'MANUAL', pnl_eur = $2, closed_at = now() WHERE id = $3`, [exitPrice, pnlEur, trade.id]);
    const { rows: balRows } = await pgPool.query('UPDATE vwap_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur', [pnlEur]);
    await pgPool.query('INSERT INTO vwap_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);

    res.json({ ok: true, exitPrice, pnlEur, usedLastKnownPrice });
  } catch (err) {
    console.error('VWAP Bot: manuelles Schließen fehlgeschlagen:', err);
    res.status(500).json({ error: err.message || 'Fehler beim Schließen.' });
  }
});

// ============================================================
// PDH/PDL BOT - siebter, komplett unabhängiger Paper-Trading-Bot
// (eigene Strategie, eigener Kapitalschutz, eigene DB-Tabellen "pdhpdl_*").
//
// SICHERHEIT: Wie bei den anderen Bots - liest ausschließlich öffentliche
// Binance-Kursdaten, verändert nur lokal simulierte Werte. NUR SIMULATION.
//
// STRATEGIE "PDH/PDL Sweep + BOS + FVG-Einstieg":
// 1) PDH/PDL = Hoch/Tief des VORHERIGEN vollständigen UTC-Kalendertages
//    (aus 1h-Kerzen), gültig für den ganzen aktuellen Tag.
// 2) Sweep: Kurs unter-/überschreitet PDL/PDH (Docht reicht).
// 3) BOS: 5m-Kerze SCHLIESST vollständig über/unter dem letzten lokalen
//    Pivot, das während der Bewegung zum Sweep-Punkt entstand.
// 4) FVG an der BOS-Ausbruchskerze (siehe Erklärung im Chat zur
//    Interpretation "welche 3 Kerzen"), Einstieg als Limit an der
//    Gap-Kante, gültig für 10 Kerzen ab FVG-Bildung.
// 5) SL am absoluten Sweep-Extrempunkt (Mindestabstand 0,2%), TP =
//    konfigurierbares RR (Standard 1:2,5).
// ============================================================
const PDHPDL_DEFAULT_SETTINGS = { enabled: false, startCapitalEur: 100, numSlots: 5, leverage: 10, riskRewardRatio: 2.5 };

async function initPdhPdlTradingSchema() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS pdhpdl_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      start_capital_eur NUMERIC NOT NULL DEFAULT 100,
      num_slots INTEGER NOT NULL DEFAULT 5,
      leverage INTEGER NOT NULL DEFAULT 10,
      risk_reward_ratio NUMERIC NOT NULL DEFAULT 2.5,
      balance_eur NUMERIC NOT NULL DEFAULT 100,
      watched_symbols TEXT[] NOT NULL DEFAULT ARRAY['BTCUSDT','ETHUSDT','SOLUSDT'],
      last_check TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS pdhpdl_trades (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      stop_loss NUMERIC NOT NULL,
      take_profit NUMERIC NOT NULL,
      pdh NUMERIC NOT NULL,
      pdl NUMERIC NOT NULL,
      sweep_extreme NUMERIC NOT NULL,
      bos_level NUMERIC NOT NULL,
      gap_low NUMERIC NOT NULL,
      gap_high NUMERIC NOT NULL,
      margin_eur NUMERIC NOT NULL,
      position_size_eur NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL,
      exit_price NUMERIC,
      close_reason TEXT,
      pnl_eur NUMERIC,
      closed_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS pdhpdl_balance_history (
      id SERIAL PRIMARY KEY, time TIMESTAMPTZ NOT NULL DEFAULT now(), balance NUMERIC NOT NULL
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS pdhpdl_skipped_setups (
      id UUID PRIMARY KEY, symbol TEXT NOT NULL, direction TEXT NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS pdhpdl_check_log (
      symbol TEXT PRIMARY KEY,
      stage TEXT NOT NULL DEFAULT 'none',
      note TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const { rows } = await pgPool.query('SELECT id FROM pdhpdl_settings WHERE id = 1');
  if (!rows.length) {
    await pgPool.query(
      `INSERT INTO pdhpdl_settings (id, enabled, start_capital_eur, num_slots, leverage, risk_reward_ratio, balance_eur, watched_symbols)
       VALUES (1, false, $1, $2, $3, $4, $1, $5)`,
      [PDHPDL_DEFAULT_SETTINGS.startCapitalEur, PDHPDL_DEFAULT_SETTINGS.numSlots, PDHPDL_DEFAULT_SETTINGS.leverage, PDHPDL_DEFAULT_SETTINGS.riskRewardRatio,
       ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT']]
    );
    await pgPool.query('INSERT INTO pdhpdl_balance_history (balance) VALUES ($1)', [PDHPDL_DEFAULT_SETTINGS.startCapitalEur]);
  }
}

function pdhpdlRowToSettings(row) {
  return {
    enabled: row.enabled, startCapitalEur: Number(row.start_capital_eur), numSlots: Number(row.num_slots),
    leverage: Number(row.leverage), riskRewardRatio: Number(row.risk_reward_ratio), balanceEur: Number(row.balance_eur),
    watchedSymbols: row.watched_symbols, lastCheck: row.last_check ? new Date(row.last_check).getTime() : null
  };
}
async function getPdhPdlSettings() {
  const { rows } = await pgPool.query('SELECT * FROM pdhpdl_settings WHERE id = 1');
  return pdhpdlRowToSettings(rows[0]);
}
function pdhpdlRowToTrade(row) {
  return {
    id: row.id, symbol: row.symbol, direction: row.direction, entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss), takeProfit: Number(row.take_profit),
    pdh: Number(row.pdh), pdl: Number(row.pdl), sweepExtreme: Number(row.sweep_extreme), bosLevel: Number(row.bos_level),
    gapLow: Number(row.gap_low), gapHigh: Number(row.gap_high),
    marginEur: Number(row.margin_eur), positionSizeEur: Number(row.position_size_eur), leverage: Number(row.leverage),
    reason: row.reason, openedAt: new Date(row.opened_at).getTime(),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null, closeReason: row.close_reason,
    pnlEur: row.pnl_eur != null ? Number(row.pnl_eur) : null, closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null
  };
}

const pdhpdlLastPrices = {};

// PDH/PDL = Hoch/Tief des vorherigen VOLLSTÄNDIGEN UTC-Kalendertages.
function computePdhPdl(candles1h) {
  const days = {};
  for (const c of candles1h) {
    const day = new Date(c.time).toISOString().slice(0, 10);
    if (!days[day]) days[day] = { high: -Infinity, low: Infinity };
    days[day].high = Math.max(days[day].high, c.high);
    days[day].low = Math.min(days[day].low, c.low);
  }
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (!days[yesterday]) return null;
  return { pdh: days[yesterday].high, pdl: days[yesterday].low, date: yesterday };
}

// Analysiert eine Richtung (Long nach PDL-Sweep / Short nach PDH-Sweep) und
// gibt entweder ein ausgelöstes Setup zurück oder eine Diagnose, wie weit
// der Ablauf (Sweep -> BOS -> FVG -> Rücktest) gerade gekommen ist - für
// den "Letzte Prüfungen"-Bereich.
// Vereinfachte Heuristik, keine Garantie für korrekte Mustererkennung.
// Interpretation der FVG-Position (nicht explizit spezifiziert): die drei
// Kerzen der FVG sind die Kerze vor, die BOS-Kerze selbst und die Kerze
// danach (K1=BOS-1, K2=BOS, K3=BOS+1) - die gängigste Lesart für "FVG an
// der Ausbruchskerze".
function analyzePdhPdlSide(candles, level, direction, highs, lows) {
  const n = candles.length;
  const searchStart = Math.max(2, n - 80);
  let bestStatus = { stage: 'none', note: `Kein ${direction === 'long' ? 'PDL' : 'PDH'}-Sweep in diesem Zeitraum.` };

  for (let sweepIdx = n - 4; sweepIdx >= searchStart; sweepIdx--) {
    const swept = direction === 'long' ? candles[sweepIdx].low < level : candles[sweepIdx].high > level;
    if (!swept) continue;

    const pivots = direction === 'long' ? highs.filter(h => h.index < sweepIdx) : lows.filter(l => l.index < sweepIdx);
    if (!pivots.length) continue;
    const pivot = pivots[pivots.length - 1];

    let extreme = direction === 'long' ? candles[sweepIdx].low : candles[sweepIdx].high;
    let bosIndex = -1;
    for (let j = sweepIdx; j < n; j++) {
      extreme = direction === 'long' ? Math.min(extreme, candles[j].low) : Math.max(extreme, candles[j].high);
      const brokeOut = direction === 'long' ? candles[j].close > pivot.price : candles[j].close < pivot.price;
      if (brokeOut) { bosIndex = j; break; }
    }
    if (bosIndex === -1) {
      bestStatus = { stage: 'sweep', note: `${direction === 'long' ? 'PDL' : 'PDH'}-Sweep erkannt (${formatPriceDynamic(level)}), BOS über/unter Pivot ${formatPriceDynamic(pivot.price)} noch ausstehend.` };
      continue;
    }

    const k1i = bosIndex - 1, k3i = bosIndex + 1;
    if (k1i < 0 || k3i >= n) {
      bestStatus = { stage: 'bos', note: `BOS über/unter ${formatPriceDynamic(pivot.price)} bestätigt, FVG-Kerzen noch nicht vollständig.` };
      continue;
    }
    const k1 = candles[k1i], k3 = candles[k3i];
    const validGap = direction === 'long' ? k1.high < k3.low : k1.low > k3.high;
    if (!validGap) {
      bestStatus = { stage: 'bos', note: `BOS bestätigt, aber keine gültige FVG an der Ausbruchskerze entstanden.` };
      continue;
    }
    const gapLow = direction === 'long' ? k1.high : k3.high;
    const gapHigh = direction === 'long' ? k3.low : k1.low;

    const last = candles[n - 1];
    const age = (n - 1) - k3i;
    if (age > 10) {
      bestStatus = { stage: 'expired', note: `FVG (${formatPriceDynamic(gapLow)}-${formatPriceDynamic(gapHigh)}) gebildet, aber innerhalb von 10 Kerzen nicht zurückgetestet - Setup verfallen.` };
      continue;
    }
    if (age <= 0) {
      bestStatus = { stage: 'fvg_forming', note: `FVG (${formatPriceDynamic(gapLow)}-${formatPriceDynamic(gapHigh)}) gerade entstanden, wartet auf Rücktest.` };
      continue;
    }
    const touchesNow = last.low <= gapHigh && last.high >= gapLow;
    const prev = candles[n - 2];
    const touchedBefore = prev.low <= gapHigh && prev.high >= gapLow;
    if (touchesNow && !touchedBefore) {
      return {
        stage: 'triggered', direction, sweepExtreme: extreme, bosLevel: pivot.price, gapLow, gapHigh,
        entryPrice: direction === 'long' ? gapHigh : gapLow
      };
    }
    bestStatus = { stage: 'fvg_waiting', note: `FVG (${formatPriceDynamic(gapLow)}-${formatPriceDynamic(gapHigh)}) gebildet, wartet auf Rücktest (noch ${10 - age} Kerzen gültig).` };
  }
  return bestStatus;
}

function detectPdhPdlSetup(candles, pdh, pdl) {
  const { highs, lows } = findLocalExtrema(candles, 4);
  const longStatus = analyzePdhPdlSide(candles, pdl, 'long', highs, lows);
  if (longStatus.stage === 'triggered') return longStatus;
  const shortStatus = analyzePdhPdlSide(candles, pdh, 'short', highs, lows);
  if (shortStatus.stage === 'triggered') return shortStatus;

  const rank = { none: 0, sweep: 1, bos: 2, fvg_forming: 3, fvg_waiting: 4, expired: 4 };
  const chosen = (rank[shortStatus.stage] || 0) > (rank[longStatus.stage] || 0) ? shortStatus : longStatus;
  return { stage: chosen.stage, note: chosen.note };
}

function computePdhPdlSlTp(direction, entryPrice, sweepExtreme, riskReward) {
  const bufferPct = 0.001, minDistPct = 0.002;
  let stopLoss = direction === 'long' ? sweepExtreme * (1 - bufferPct) : sweepExtreme * (1 + bufferPct);
  const distPct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (distPct < minDistPct) stopLoss = direction === 'long' ? entryPrice * (1 - minDistPct) : entryPrice * (1 + minDistPct);
  const distance = Math.abs(entryPrice - stopLoss);
  const takeProfit = direction === 'long' ? entryPrice + distance * riskReward : entryPrice - distance * riskReward;
  return { stopLoss, takeProfit };
}

async function checkPdhPdlSymbol(symbol, settings) {
  const candles = await fetchPaperCandles(symbol, '5m', 200);
  const lastPrice = candles[candles.length - 1].close;
  pdhpdlLastPrices[symbol] = lastPrice;

  const { rows: openRows } = await pgPool.query("SELECT * FROM pdhpdl_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  for (const row of openRows) {
    const trade = pdhpdlRowToTrade(row);
    let closeReason = null;
    if (trade.direction === 'long') {
      if (lastPrice >= trade.takeProfit) closeReason = 'TP'; else if (lastPrice <= trade.stopLoss) closeReason = 'SL';
    } else {
      if (lastPrice <= trade.takeProfit) closeReason = 'TP'; else if (lastPrice >= trade.stopLoss) closeReason = 'SL';
    }
    if (!closeReason) continue;
    const exitPrice = lastPrice;
    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;
    await pgPool.query(`UPDATE pdhpdl_trades SET status = 'closed', exit_price = $1, close_reason = $2, pnl_eur = $3, closed_at = now() WHERE id = $4`, [exitPrice, closeReason, pnlEur, trade.id]);
    const { rows: balRows } = await pgPool.query('UPDATE pdhpdl_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur', [pnlEur]);
    await pgPool.query('INSERT INTO pdhpdl_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);
  }

  const { rows: stillOpen } = await pgPool.query("SELECT COUNT(*)::int AS c FROM pdhpdl_trades WHERE symbol = $1 AND status = 'open'", [symbol]);
  if (stillOpen[0].c > 0) return;

  const candles1h = await fetchPaperCandles(symbol, '1h', 72);
  const levels = computePdhPdl(candles1h);
  if (!levels) {
    await pgPool.query(
      `INSERT INTO pdhpdl_check_log (symbol, stage, note, checked_at) VALUES ($1, 'none', $2, now())
       ON CONFLICT (symbol) DO UPDATE SET stage = 'none', note = $2, checked_at = now()`,
      [symbol, 'PDH/PDL noch nicht berechenbar (nicht genug Historie für den Vortag).']
    );
    return;
  }

  const result = detectPdhPdlSetup(candles, levels.pdh, levels.pdl);
  await pgPool.query(
    `INSERT INTO pdhpdl_check_log (symbol, stage, note, checked_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (symbol) DO UPDATE SET stage = $2, note = $3, checked_at = now()`,
    [symbol, result.stage, result.note || (result.stage === 'triggered' ? 'Setup ausgelöst.' : null)]
  );

  if (result.stage !== 'triggered') return;

  const plan = computePdhPdlSlTp(result.direction, result.entryPrice, result.sweepExtreme, settings.riskRewardRatio);
  const marginEur = settings.startCapitalEur / settings.numSlots;
  const { rows: usedRows } = await pgPool.query("SELECT COALESCE(SUM(margin_eur), 0) AS used FROM pdhpdl_trades WHERE status = 'open'");
  const usedMarginEur = Number(usedRows[0].used);

  const reasonText = `${result.direction === 'long' ? 'PDL' : 'PDH'}-Sweep (${formatPriceDynamic(result.sweepExtreme)}), BOS über/unter ${formatPriceDynamic(result.bosLevel)}, FVG-Rücktest (${formatPriceDynamic(result.gapLow)}-${formatPriceDynamic(result.gapHigh)}) bei ${formatPriceDynamic(result.entryPrice)}. PDH ${formatPriceDynamic(levels.pdh)} / PDL ${formatPriceDynamic(levels.pdl)} (${levels.date}).`;

  if (usedMarginEur + marginEur > settings.balanceEur) {
    await pgPool.query('INSERT INTO pdhpdl_skipped_setups (id, symbol, direction, reason) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), symbol, result.direction, `Kein freier Slot verfügbar (Margin ${marginEur.toFixed(2)}€ würde die Balance überschreiten). ${reasonText}`]);
    return;
  }

  const positionSizeEur = marginEur * settings.leverage;
  await pgPool.query(
    `INSERT INTO pdhpdl_trades (id, symbol, direction, entry_price, stop_loss, take_profit, pdh, pdl, sweep_extreme, bos_level, gap_low, gap_high, margin_eur, position_size_eur, leverage, reason, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'open', now())`,
    [crypto.randomUUID(), symbol, result.direction, result.entryPrice, plan.stopLoss, plan.takeProfit, levels.pdh, levels.pdl, result.sweepExtreme, result.bosLevel, result.gapLow, result.gapHigh, marginEur, positionSizeEur, settings.leverage, reasonText]
  );
}

async function runPdhPdlTradingCycle() {
  if (!pgPool) return;
  const settings = await getPdhPdlSettings();
  if (!settings.enabled) return;
  for (const symbol of settings.watchedSymbols) {
    try { await checkPdhPdlSymbol(symbol, settings); } catch (err) { console.error(`PDH/PDL-Bot-Fehler bei ${symbol}:`, err.message || err); }
    await sleep(150);
  }
  await pgPool.query('UPDATE pdhpdl_settings SET last_check = now() WHERE id = 1');
}

const PDHPDL_CHECK_INTERVAL_MS = 4 * 60 * 1000; // 4 Minuten (Vorgabe: 3-5 Min)
setInterval(runPdhPdlTradingCycle, PDHPDL_CHECK_INTERVAL_MS);

app.get('/api/pdhpdl-trading/state', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - PDH/PDL Bot nicht verfügbar.' });
  try {
    const settings = await getPdhPdlSettings();
    const { rows: openRows } = await pgPool.query("SELECT * FROM pdhpdl_trades WHERE status = 'open' ORDER BY opened_at DESC");
    const { rows: closedRows } = await pgPool.query("SELECT * FROM pdhpdl_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
    const { rows: historyRows } = await pgPool.query('SELECT time, balance FROM pdhpdl_balance_history ORDER BY time ASC');
    const { rows: skippedRows } = await pgPool.query('SELECT * FROM pdhpdl_skipped_setups ORDER BY created_at DESC LIMIT 50');
    const { rows: checkLogRows } = await pgPool.query('SELECT * FROM pdhpdl_check_log ORDER BY checked_at DESC');

    const openTrades = openRows.map(pdhpdlRowToTrade).map(t => {
      const currentPrice = pdhpdlLastPrices[t.symbol] ?? null;
      let unrealizedPnlEur = null;
      if (currentPrice != null) {
        unrealizedPnlEur = t.direction === 'long'
          ? (currentPrice - t.entryPrice) / t.entryPrice * t.positionSizeEur
          : (t.entryPrice - currentPrice) / t.entryPrice * t.positionSizeEur;
      }
      return { ...t, currentPrice, unrealizedPnlEur };
    });
    const closedTrades = closedRows.map(pdhpdlRowToTrade);
    const balanceHistory = historyRows.map(r => ({ time: new Date(r.time).getTime(), balance: Number(r.balance) }));
    const skippedSetups = skippedRows.map(r => ({ id: r.id, symbol: r.symbol, direction: r.direction, reason: r.reason, createdAt: new Date(r.created_at).getTime() }));
    const checkLog = checkLogRows.map(r => ({ symbol: r.symbol, stage: r.stage, note: r.note, checkedAt: new Date(r.checked_at).getTime() }));

    res.json({ settings, balanceEur: settings.balanceEur, balanceHistory, openTrades, closedTrades, skippedSetups, checkLog, lastCheck: settings.lastCheck, checkIntervalMs: PDHPDL_CHECK_INTERVAL_MS });
  } catch (err) {
    console.error('PDH/PDL Bot: state-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/pdhpdl-trading/settings', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - PDH/PDL Bot nicht verfügbar.' });
  try {
    const incoming = req.body || {};
    const current = await getPdhPdlSettings();
    const wasEnabled = current.enabled;
    const next = {
      enabled: !!incoming.enabled,
      startCapitalEur: Number(incoming.startCapitalEur) > 0 ? Number(incoming.startCapitalEur) : current.startCapitalEur,
      numSlots: Number(incoming.numSlots) >= 1 ? Math.round(Number(incoming.numSlots)) : current.numSlots,
      leverage: Number(incoming.leverage) >= 1 && Number(incoming.leverage) <= 10 ? Math.round(Number(incoming.leverage)) : current.leverage,
      riskRewardRatio: Number(incoming.riskRewardRatio) > 0 ? Number(incoming.riskRewardRatio) : current.riskRewardRatio,
      watchedSymbols: Array.isArray(incoming.watchedSymbols) && incoming.watchedSymbols.length ? incoming.watchedSymbols : current.watchedSymbols
    };
    const leverageWarning = await checkLeverageChangeWarning('pdhpdl_trades', current.leverage, next.leverage);

    await pgPool.query(
      `UPDATE pdhpdl_settings SET enabled = $1, start_capital_eur = $2, num_slots = $3, leverage = $4, risk_reward_ratio = $5, watched_symbols = $6 WHERE id = 1`,
      [next.enabled, next.startCapitalEur, next.numSlots, next.leverage, next.riskRewardRatio, next.watchedSymbols]
    );
    if (next.enabled && !wasEnabled) runPdhPdlTradingCycle();
    res.json({ ok: true, settings: next, leverageWarning });
  } catch (err) {
    console.error('PDH/PDL Bot: settings-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/pdhpdl-trading/reset', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - PDH/PDL Bot nicht verfügbar.' });
  try {
    const settings = await getPdhPdlSettings();
    await pgPool.query('DELETE FROM pdhpdl_trades');
    await pgPool.query('DELETE FROM pdhpdl_balance_history');
    await pgPool.query('DELETE FROM pdhpdl_skipped_setups');
    await pgPool.query('DELETE FROM pdhpdl_check_log');
    await pgPool.query('UPDATE pdhpdl_settings SET balance_eur = $1, last_check = NULL WHERE id = 1', [settings.startCapitalEur]);
    await pgPool.query('INSERT INTO pdhpdl_balance_history (balance) VALUES ($1)', [settings.startCapitalEur]);
    Object.keys(pdhpdlLastPrices).forEach(k => delete pdhpdlLastPrices[k]);
    res.json({ ok: true });
  } catch (err) {
    console.error('PDH/PDL Bot: reset-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/pdhpdl-trading/close/:id', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - PDH/PDL Bot nicht verfügbar.' });
  try {
    const { rows } = await pgPool.query("SELECT * FROM pdhpdl_trades WHERE id = $1 AND status = 'open'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Offener Trade nicht gefunden.' });
    const trade = pdhpdlRowToTrade(rows[0]);

    let exitPrice, usedLastKnownPrice = false;
    try {
      exitPrice = await fetchLiveTickerPriceWithRetry(trade.symbol);
    } catch (err) {
      const cached = pdhpdlLastPrices[trade.symbol];
      if (cached == null) return res.status(503).json({ error: `Aktueller Kurs für ${trade.symbol} nicht abrufbar (${err.message}) und kein zwischengespeicherter Preis vorhanden. Bitte später erneut versuchen.` });
      exitPrice = cached;
      usedLastKnownPrice = true;
    }

    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;

    await pgPool.query(`UPDATE pdhpdl_trades SET status = 'closed', exit_price = $1, close_reason = 'MANUAL', pnl_eur = $2, closed_at = now() WHERE id = $3`, [exitPrice, pnlEur, trade.id]);
    const { rows: balRows } = await pgPool.query('UPDATE pdhpdl_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur', [pnlEur]);
    await pgPool.query('INSERT INTO pdhpdl_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);

    res.json({ ok: true, exitPrice, pnlEur, usedLastKnownPrice });
  } catch (err) {
    console.error('PDH/PDL Bot: manuelles Schließen fehlgeschlagen:', err);
    res.status(500).json({ error: err.message || 'Fehler beim Schließen.' });
  }
});

const PORT = process.env.PORT || 5055;

initPaperTradingSchema()
  .then(() => {
    if (pgPool) console.log('Paper-Trading: Datenbank-Schema bereit.');
  })
  .catch(err => console.error('Paper-Trading: Schema-Initialisierung fehlgeschlagen:', err));

initNyTradingSchema()
  .then(() => {
    if (pgPool) console.log('NY Range Bot: Datenbank-Schema bereit.');
  })
  .catch(err => console.error('NY Range Bot: Schema-Initialisierung fehlgeschlagen:', err));

initScalpTradingSchema()
  .then(() => {
    if (pgPool) console.log('Scalping Bot: Datenbank-Schema bereit.');
  })
  .catch(err => console.error('Scalping Bot: Schema-Initialisierung fehlgeschlagen:', err));

initFvgTradingSchema()
  .then(() => {
    if (pgPool) console.log('FVG Bot: Datenbank-Schema bereit.');
  })
  .catch(err => console.error('FVG Bot: Schema-Initialisierung fehlgeschlagen:', err));

initCandleTradingSchema()
  .then(() => {
    if (pgPool) console.log('Candlestick Bot: Datenbank-Schema bereit.');
  })
  .catch(err => console.error('Candlestick Bot: Schema-Initialisierung fehlgeschlagen:', err));

initVwapTradingSchema()
  .then(() => {
    if (pgPool) console.log('VWAP Bot: Datenbank-Schema bereit.');
  })
  .catch(err => console.error('VWAP Bot: Schema-Initialisierung fehlgeschlagen:', err));

initPdhPdlTradingSchema()
  .then(() => {
    if (pgPool) console.log('PDH/PDL Bot: Datenbank-Schema bereit.');
  })
  .catch(err => console.error('PDH/PDL Bot: Schema-Initialisierung fehlgeschlagen:', err));

app.listen(PORT, () => {
  console.log(`Jarvis-Server läuft auf http://localhost:${PORT}`);
  console.log(`Gemini konfiguriert: ${!!GEMINI_API_KEY} (Modell: ${GEMINI_MODEL})`);
  console.log(`MEXC konfiguriert: ${!!(MEXC_API_KEY && MEXC_API_SECRET)}`);
  console.log(`Datenbank (Auto Trader) konfiguriert: ${!!DATABASE_URL}`);
});
