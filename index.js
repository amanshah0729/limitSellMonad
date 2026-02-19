import "dotenv/config";
import { ethers } from "ethers";

// ── Tokens to track ─────────────────────────────────────────────────
const TOKENS = [
  {
    symbol: "TCG",
    entryPrice: 0.000374572087361472,
    takeProfitX: 2.5,
    stopLossPct: 0.20,
    sold: false,
  },
  {
    symbol: "MONA",
    entryPrice: 0.000070248768223832,
    takeProfitX: 5,
    stopLossPct: 0.20,
    sold: false,
  },
];

for (const t of TOKENS) {
  t.takeProfitPrice = t.entryPrice * t.takeProfitX;
  t.stopLossPrice = t.entryPrice * (1 - t.stopLossPct);
}

const SLIPPAGE_BPS = 100; // 1%
const POLL_MS = 7000;
const MAX_SELL_RETRIES = 3;

// ── Contracts (Monad mainnet) ───────────────────────────────────────
const LENS_ADDRESS = "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea";
const BONDING_CURVE_ROUTER = "0x6F6B8F1a20703309951a5127c45B49b1CD981A22";
const DEX_ROUTER = "0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137";

const LENS_ABI = [
  "function getAmountOut(address token, uint256 amountIn, bool isBuy) view returns (address router, uint256 amountOut)",
];

const ROUTER_ABI = [
  "function sell(tuple(uint256 amountIn, uint256 amountOutMin, address token, address to, uint256 deadline))",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// ── Logging ─────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function logError(msg, err) {
  console.error(`[${ts()}] ERROR: ${msg}`);
  if (err) {
    console.error(`[${ts()}]   message: ${err.message}`);
    if (err.code) console.error(`[${ts()}]   code: ${err.code}`);
    if (err.reason) console.error(`[${ts()}]   reason: ${err.reason}`);
    if (err.data) console.error(`[${ts()}]   data: ${err.data}`);
    if (err.transaction?.hash) console.error(`[${ts()}]   tx: ${err.transaction.hash}`);
  }
}

// ── Wallet setup ────────────────────────────────────────────────────
if (!process.env.PRIVATE_KEY || !process.env.RPC_URL) {
  console.error("FATAL: PRIVATE_KEY and RPC_URL must be set in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const lens = new ethers.Contract(LENS_ADDRESS, LENS_ABI, provider);
const bondingRouter = new ethers.Contract(BONDING_CURVE_ROUTER, ROUTER_ABI, wallet);
const dexRouter = new ethers.Contract(DEX_ROUTER, ROUTER_ABI, wallet);

log(`Bot started`);
log(`Wallet: ${wallet.address}`);
log(`RPC: ${process.env.RPC_URL}`);
log(`Polling every ${POLL_MS / 1000}s`);
log(``);
for (const t of TOKENS) {
  log(`${t.symbol}: entry $${t.entryPrice} | TP ${t.takeProfitX}x @ $${t.takeProfitPrice.toFixed(12)} | SL -${t.stopLossPct * 100}% @ $${t.stopLossPrice.toFixed(12)}`);
}
log(``);

// ── API polling ─────────────────────────────────────────────────────
const API_URL = "https://api.nadapp.net/order/latest_trade?page=1&limit=30&is_nsfw=false";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0",
];

let uaIndex = 0;
let consecutiveErrors = 0;

function getHeaders() {
  const ua = USER_AGENTS[uaIndex++ % USER_AGENTS.length];
  return {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    priority: "u=1, i",
    "sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    Referer: "https://nad.fun/",
    "user-agent": ua,
  };
}

// ── Sell logic ──────────────────────────────────────────────────────
async function executeSell(tokenAddress, symbolLabel, reason) {
  log(`[${symbolLabel}] SELL TRIGGERED — reason: ${reason}`);
  log(`[${symbolLabel}] Executing on-chain sell...`);

  for (let attempt = 1; attempt <= MAX_SELL_RETRIES; attempt++) {
    try {
      if (attempt > 1) log(`[${symbolLabel}] Sell attempt ${attempt}/${MAX_SELL_RETRIES}...`);

      const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
      const balance = await token.balanceOf(wallet.address);

      if (balance === 0n) {
        log(`[${symbolLabel}] No token balance to sell.`);
        return true;
      }

      log(`[${symbolLabel}] Token balance: ${ethers.formatEther(balance)}`);

      log(`[${symbolLabel}] Querying Lens for best route...`);
      const [routerAddr, expectedOut] = await lens.getAmountOut(tokenAddress, balance, false);
      const minOut = (expectedOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

      const routerName = routerAddr === BONDING_CURVE_ROUTER ? "BondingCurveRouter" : "DexRouter";
      log(`[${symbolLabel}] Router: ${routerName} (${routerAddr})`);
      log(`[${symbolLabel}] Expected MON out: ${ethers.formatEther(expectedOut)}`);
      log(`[${symbolLabel}] Min MON out (${SLIPPAGE_BPS / 100}% slippage): ${ethers.formatEther(minOut)}`);

      const currentAllowance = await token.allowance(wallet.address, routerAddr);
      if (currentAllowance < balance) {
        log(`[${symbolLabel}] Approving tokens...`);
        const approveTx = await token.approve(routerAddr, balance);
        log(`[${symbolLabel}] Approve tx submitted: ${approveTx.hash}`);
        const approveReceipt = await approveTx.wait();
        log(`[${symbolLabel}] Approve confirmed in block ${approveReceipt.blockNumber}`);
      } else {
        log(`[${symbolLabel}] Allowance sufficient, skipping approve.`);
      }

      const router = routerAddr === BONDING_CURVE_ROUTER ? bondingRouter : dexRouter;
      const deadline = Math.floor(Date.now() / 1000) + 300;

      log(`[${symbolLabel}] Submitting sell transaction...`);
      const sellTx = await router.sell({
        amountIn: balance,
        amountOutMin: minOut,
        token: tokenAddress,
        to: wallet.address,
        deadline,
      });

      log(`[${symbolLabel}] Sell tx submitted: ${sellTx.hash}`);
      log(`[${symbolLabel}] Waiting for confirmation...`);
      const receipt = await sellTx.wait();
      log(`[${symbolLabel}] CONFIRMED in block ${receipt.blockNumber} | gas: ${receipt.gasUsed.toString()}`);
      log(`[${symbolLabel}] SOLD ALL.`);

      return true;
    } catch (err) {
      logError(`[${symbolLabel}] Sell attempt ${attempt} failed`, err);
      if (attempt < MAX_SELL_RETRIES) {
        const wait = attempt * 2000;
        log(`[${symbolLabel}] Retrying in ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        logError(`[${symbolLabel}] All ${MAX_SELL_RETRIES} sell attempts failed. Will retry next poll.`);
      }
    }
  }
  return false;
}

// ── Main loop ───────────────────────────────────────────────────────
async function poll() {
  const allSold = TOKENS.every((t) => t.sold);
  if (allSold) {
    log("All tokens sold. Bot stopping.");
    process.exit(0);
  }

  try {
    const res = await fetch(API_URL, { headers: getHeaders(), method: "GET" });

    if (!res.ok) {
      consecutiveErrors++;
      logError(`API returned ${res.status} (${consecutiveErrors} consecutive errors)`);
      if (consecutiveErrors >= 10) {
        logError("10+ consecutive API errors — check if nad.fun API is down");
      }
      return;
    }

    const data = await res.json();
    if (!data.tokens || !Array.isArray(data.tokens)) {
      consecutiveErrors++;
      logError(`Unexpected API response shape (${consecutiveErrors} consecutive errors)`);
      return;
    }

    consecutiveErrors = 0;

    for (const tracked of TOKENS) {
      if (tracked.sold) continue;

      const match = data.tokens.find(
        (t) => t.token_info.symbol.toUpperCase() === tracked.symbol.toUpperCase()
      );

      if (!match) {
        log(`${tracked.symbol} not in latest trades`);
        continue;
      }

      const { token_info, market_info, percent } = match;
      const price = parseFloat(market_info.price_usd);
      const pct = (percent >= 0 ? "+" : "") + percent.toFixed(2) + "%";
      const ratio = (price / tracked.entryPrice).toFixed(2);

      let tag = "";
      if (price >= tracked.takeProfitPrice) tag = " <<< TAKE PROFIT";
      else if (price <= tracked.stopLossPrice) tag = " <<< STOP LOSS";

      log(`${tracked.symbol} | $${market_info.price_usd} | ${pct} | ${ratio}x${tag}`);

      if (price >= tracked.takeProfitPrice) {
        const ok = await executeSell(token_info.token_id, tracked.symbol, `TAKE PROFIT at $${market_info.price_usd} (${ratio}x)`);
        if (ok) tracked.sold = true;
      } else if (price <= tracked.stopLossPrice) {
        const ok = await executeSell(token_info.token_id, tracked.symbol, `STOP LOSS at $${market_info.price_usd} (${ratio}x)`);
        if (ok) tracked.sold = true;
      }
    }
  } catch (err) {
    consecutiveErrors++;
    logError(`Poll failed (${consecutiveErrors} consecutive errors)`, err);
  }
}

// ── Crash handlers ──────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  logError("UNCAUGHT EXCEPTION — bot still running", err);
});

process.on("unhandledRejection", (err) => {
  logError("UNHANDLED REJECTION — bot still running", err);
});

poll();
setInterval(poll, POLL_MS);
