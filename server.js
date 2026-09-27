/**
 * 토스증권 Open API 조회 전용 프록시 서버
 * ------------------------------------------------
 * - 이 서버는 "조회(GET)"만 합니다. 매매 주문 관련 엔드포인트는
 *   의도적으로 아예 구현하지 않았습니다. 코드에 주문 로직을 추가하지 마세요.
 * - client_id / client_secret은 이 서버(.env)에만 보관되고,
 *   가계부.html 같은 브라우저 쪽 파일에는 절대 넣지 않습니다.
 * - 가계부 앱은 이 서버가 내려주는 x-app-token(APP_TOKEN)이 맞는 요청에만
 *   응답을 받습니다.
 *
 * 엔드포인트 출처: https://openapi.tossinvest.com/openapi-docs/overview.md (공식 문서, 2026-09 확인)
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const APP_TOKEN = process.env.APP_TOKEN;
const CLIENT_ID = process.env.TOSS_CLIENT_ID;
const CLIENT_SECRET = process.env.TOSS_CLIENT_SECRET;

const TOSS_TOKEN_URL = process.env.TOSS_TOKEN_URL || 'https://openapi.tossinvest.com/oauth2/token';
const TOSS_ACCOUNTS_URL = process.env.TOSS_ACCOUNTS_URL || 'https://openapi.tossinvest.com/api/v1/accounts';
const TOSS_HOLDINGS_URL = process.env.TOSS_HOLDINGS_URL || 'https://openapi.tossinvest.com/api/v1/holdings';
const TOSS_QUOTE_URL = process.env.TOSS_QUOTE_URL || 'https://openapi.tossinvest.com/api/v1/prices'; // ?symbols=005930

if (!APP_TOKEN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('환경변수 누락: APP_TOKEN / TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 을 .env에 설정해주세요.');
  process.exit(1);
}

// ---- CORS: 가계부.html에서 이 서버로 직접 fetch 할 수 있도록 허용 ----
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-app-token, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- 우리 앱(가계부)만 이 서버를 쓸 수 있도록 간단한 토큰 검사 ----
function requireAppToken(req, res, next) {
  const token = req.header('x-app-token');
  if (!token || token !== APP_TOKEN) {
    return res.status(401).json({ error: 'unauthorized', message: 'x-app-token 헤더가 없거나 올바르지 않습니다.' });
  }
  next();
}

// ---- 토스 OAuth2 액세스 토큰 캐싱 (Client Credentials Grant) ----
let cachedToken = null; // { access_token, expires_at }

async function getTossAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at > now + 30_000) {
    return cachedToken.access_token;
  }
  const resp = await fetch(TOSS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`토스 토큰 발급 실패 (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  const expiresInMs = (data.expires_in ? Number(data.expires_in) : 3600) * 1000;
  cachedToken = {
    access_token: data.access_token,
    expires_at: now + expiresInMs
  };
  return cachedToken.access_token;
}

async function tossFetch(url, accountSeq) {
  const accessToken = await getTossAccessToken();
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (accountSeq) headers['X-Tossinvest-Account'] = String(accountSeq);
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`토스 API 호출 실패 (${resp.status}): ${text}`);
  }
  return resp.json();
}

// 계좌 목록에서 첫 번째 accountSeq를 가져온다 (계좌·자산 API는 이 헤더가 필수)
async function getFirstAccountSeq() {
  const data = await tossFetch(TOSS_ACCOUNTS_URL);
  const result = data.result || data;
  const list = result.items || result.accounts || (Array.isArray(result) ? result : []);
  const first = Array.isArray(list) ? list[0] : null;
  const seq = first && (first.accountSeq ?? first.seq ?? first.id);
  if (seq === undefined || seq === null) {
    throw new Error('계좌 목록에서 accountSeq를 찾지 못했습니다: ' + JSON.stringify(data).slice(0, 300));
  }
  return seq;
}

// ---- 헬스체크 ----
app.get('/health', (req, res) => res.json({ ok: true }));

// ---- 보유 종목/잔고 조회 (조회 전용) ----
app.get('/holdings', requireAppToken, async (req, res) => {
  try {
    const accountSeq = await getFirstAccountSeq();
    const data = await tossFetch(TOSS_HOLDINGS_URL, accountSeq);
    const result = data.result || data;
    const items = result.items || result.holdings || [];
    const normalized = items.map(it => {
      const qty = it.quantity !== undefined ? Number(it.quantity) : null;
      const currentPrice = it.lastPrice !== undefined ? Number(it.lastPrice) : (it.currentPrice !== undefined ? Number(it.currentPrice) : null);
      const plAmount = it.profitLoss && it.profitLoss.amount !== undefined ? Number(it.profitLoss.amount) : null;
      const valuation = (qty !== null && currentPrice !== null) ? qty * currentPrice : null;
      let purchaseAmount = it.purchaseAmount !== undefined ? Number(it.purchaseAmount) : null;
      if (purchaseAmount === null && valuation !== null && plAmount !== null) {
        purchaseAmount = valuation - plAmount;
      }
      return {
        symbol: it.symbol || it.code || '',
        name: it.name || it.symbol || '',
        qty,
        currentPrice,
        purchaseAmount: purchaseAmount || 0
      };
    });
    res.json({ items: normalized, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'toss_fetch_failed', message: String(err.message || err) });
  }
});

// ---- 단일 종목 현재가 조회 (조회 전용, 보조용) ----
app.get('/price', requireAppToken, async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) return res.status(400).json({ error: 'missing_symbol' });
  try {
    const data = await tossFetch(`${TOSS_QUOTE_URL}?symbols=${encodeURIComponent(symbol)}`);
    res.json(data.result || data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'toss_fetch_failed', message: String(err.message || err) });
  }
});

// ==================================================
// 가계부 데이터 저장소 (여러 기기 동기화용, 조회/저장/삭제)
// 파일 하나(budget-data.json)에 key-value로 저장합니다.
// ==================================================
const BUDGET_DATA_FILE = path.join(__dirname, 'budget-data.json');

function loadBudgetStore() {
  try {
    const raw = fs.readFileSync(BUDGET_DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveBudgetStore(store) {
  fs.writeFileSync(BUDGET_DATA_FILE, JSON.stringify(store), 'utf8');
}

let budgetStore = loadBudgetStore();

app.get('/budget/kv', requireAppToken, (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'missing_key' });
  const value = Object.prototype.hasOwnProperty.call(budgetStore, key) ? budgetStore[key] : null;
  res.json({ key, value });
});

app.put('/budget/kv', requireAppToken, (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'missing_key' });
  budgetStore[key] = value;
  try {
    saveBudgetStore(budgetStore);
  } catch (e) {
    console.error('가계부 데이터 저장 실패', e);
    return res.status(500).json({ error: 'save_failed', message: String(e.message || e) });
  }
  res.json({ key, ok: true });
});

app.delete('/budget/kv', requireAppToken, (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'missing_key' });
  delete budgetStore[key];
  try {
    saveBudgetStore(budgetStore);
  } catch (e) {
    console.error('가계부 데이터 삭제 실패', e);
    return res.status(500).json({ error: 'delete_failed', message: String(e.message || e) });
  }
  res.json({ key, ok: true });
});

app.listen(PORT, () => {
  console.log(`토스증권 조회 전용 프록시 서버 실행 중: http://0.0.0.0:${PORT}`);
});
