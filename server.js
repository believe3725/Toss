/**
 * 토스증권 Open API 조회 전용 프록시 서버
 * ------------------------------------------------
 * - 이 서버는 "조회(GET)"만 합니다. 매매 주문 관련 엔드포인트는
 *   의도적으로 아예 구현하지 않았습니다. 코드에 주문 로직을 추가하지 마세요.
 * - client_id / client_secret은 이 서버(.env)에만 보관되고,
 *   가계부.html 같은 브라우저 쪽 파일에는 절대 넣지 않습니다.
 * - 가계부 앱은 이 서버가 내려주는 x-app-token(APP_TOKEN)이 맞는 요청에만
 *   응답을 받습니다. 이 토큰이 없으면 누구나 내 잔고를 볼 수 있게 되니
 *   반드시 설정하세요.
 *
 * ⚠️ TODO: 아래 TOSS_TOKEN_URL / TOSS_HOLDINGS_URL / TOSS_QUOTE_URL 은
 * developers.tossinvest.com 공식 문서에서 실제 경로를 확인한 뒤
 * .env 파일에 정확한 값으로 채워주세요. 여기 적힌 값은 검색으로 확인한
 * 참고용 추정치라 문서와 다를 수 있습니다.
 */

require('dotenv').config();
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const APP_TOKEN = process.env.APP_TOKEN;
const CLIENT_ID = process.env.TOSS_CLIENT_ID;
const CLIENT_SECRET = process.env.TOSS_CLIENT_SECRET;

const TOSS_TOKEN_URL = process.env.TOSS_TOKEN_URL || 'https://oauth2.tossinvest.com/oauth2/token';
const TOSS_HOLDINGS_URL = process.env.TOSS_HOLDINGS_URL || 'https://openapi.tossinvest.com/api/v1/accounts/holdings';
const TOSS_QUOTE_URL = process.env.TOSS_QUOTE_URL || 'https://openapi.tossinvest.com/api/v1/stocks'; // ?symbols=005930

if (!APP_TOKEN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('환경변수 누락: APP_TOKEN / TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 을 .env에 설정해주세요.');
  process.exit(1);
}

// ---- CORS: 가계부.html에서 이 서버로 직접 fetch 할 수 있도록 허용 ----
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-app-token, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

// ---- 토스 OAuth2 액세스 토큰 캐싱 ----
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

async function tossFetch(url) {
  const accessToken = await getTossAccessToken();
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`토스 API 호출 실패 (${resp.status}): ${text}`);
  }
  return resp.json();
}

// ---- 헬스체크 ----
app.get('/health', (req, res) => res.json({ ok: true }));

// ---- 보유 종목/잔고 조회 (조회 전용) ----
app.get('/holdings', requireAppToken, async (req, res) => {
  try {
    const data = await tossFetch(TOSS_HOLDINGS_URL);
    // 토스 응답은 { result: { items: [...], totalPurchaseAmount, totalValuationAmount, ... } } 형태로
    // 감싸져 있을 가능성이 높습니다 (문서 확인 후 아래 매핑을 맞춰주세요).
    const result = data.result || data;
    const items = result.items || result.holdings || [];
    const normalized = items.map(it => ({
      symbol: it.symbol || it.code || it.productCode || '',
      name: it.name || it.productName || it.symbolName || '',
      qty: Number(it.quantity ?? it.qty ?? 0),
      avgPrice: Number(it.avgPrice ?? it.purchasePrice ?? 0),
      currentPrice: Number(it.currentPrice ?? it.price ?? 0),
      purchaseAmount: Number(it.purchaseAmount ?? it.totalPurchaseAmount ?? 0),
      valuationAmount: Number(it.valuationAmount ?? it.totalValuationAmount ?? 0)
    }));
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

app.listen(PORT, () => {
  console.log(`토스증권 조회 전용 프록시 서버 실행 중: http://0.0.0.0:${PORT}`);
});
