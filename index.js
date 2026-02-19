import "dotenv/config";
import { ethers } from "ethers";

// ── Config ──────────────────────────────────────────────────────────
const TARGET_SYMBOL = "TCG";
const ENTRY_PRICE = 0.000374572087361472;
const SELL_MULTIPLIER = 2.5;
const SELL_PRICE = ENTRY_PRICE * SELL_MULTIPLIER;
const STOP_LOSS_PCT = 0.20; // 20% drop from entry = sell
const STOP_LOSS_PRICE = ENTRY_PRICE * (1 - STOP_LOSS_PCT);
const SLIPPAGE_BPS = 100; // 1%
const POLL_MS = 7000;

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

// ── Wallet setup ────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const lens = new ethers.Contract(LENS_ADDRESS, LENS_ABI, provider);
const bondingRouter = new ethers.Contract(BONDING_CURVE_ROUTER, ROUTER_ABI, wallet);
const dexRouter = new ethers.Contract(DEX_ROUTER, ROUTER_ABI, wallet);

console.log(`Wallet: ${wallet.address}`);
console.log(`Take profit: sell all ${TARGET_SYMBOL} when price >= $${SELL_PRICE.toFixed(12)} (${SELL_MULTIPLIER}x)`);
console.log(`Stop loss:   sell all ${TARGET_SYMBOL} when price <= $${STOP_LOSS_PRICE.toFixed(12)} (-${STOP_LOSS_PCT * 100}%)`);
console.log(`Polling every ${POLL_MS / 1000}s...\n`);

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
let sold = false;

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
async function executeSell(tokenAddress) {
  console.log("\n🚨 SELL TRIGGERED — executing on-chain sell...\n");

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const balance = await token.balanceOf(wallet.address);

  if (balance === 0n) {
    console.log("No token balance to sell.");
    return;
  }

  console.log(`Token balance: ${ethers.formatEther(balance)} ${TARGET_SYMBOL}`);

  const [routerAddr, expectedOut] = await lens.getAmountOut(tokenAddress, balance, false);
  const minOut = (expectedOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

  console.log(`Expected MON out: ${ethers.formatEther(expectedOut)}`);
  console.log(`Min MON out (${SLIPPAGE_BPS / 100}% slippage): ${ethers.formatEther(minOut)}`);
  console.log(`Router: ${routerAddr}`);

  const currentAllowance = await token.allowance(wallet.address, routerAddr);
  if (currentAllowance < balance) {
    console.log("Approving tokens...");
    const approveTx = await token.approve(routerAddr, balance);
    await approveTx.wait();
    console.log(`Approved: ${approveTx.hash}`);
  }

  const router = routerAddr === BONDING_CURVE_ROUTER ? bondingRouter : dexRouter;
  const deadline = Math.floor(Date.now() / 1000) + 300;

  const sellTx = await router.sell({
    amountIn: balance,
    amountOutMin: minOut,
    token: tokenAddress,
    to: wallet.address,
    deadline,
  });

  console.log(`Sell tx submitted: ${sellTx.hash}`);
  const receipt = await sellTx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);
  console.log("SOLD ALL. Bot stopping.");

  sold = true;
}

// ── Main loop ───────────────────────────────────────────────────────
async function poll() {
  if (sold) return;

  try {
    const res = await fetch(API_URL, { headers: getHeaders(), method: "GET" });
    if (!res.ok) {
      console.error(`[${ts()}] API ${res.status}`);
      return;
    }
    const data = await res.json();
    if (!data.tokens || !Array.isArray(data.tokens)) {
      console.error(`[${ts()}] Bad response, retrying...`);
      return;
    }

    const match = data.tokens.find(
      (t) => t.token_info.symbol.toUpperCase() === TARGET_SYMBOL.toUpperCase()
    );

    if (!match) {
      console.log(`[${ts()}] ${TARGET_SYMBOL} not in latest trades`);
      return;
    }

    const { token_info, market_info, percent } = match;
    const price = parseFloat(market_info.price_usd);
    const pct = (percent >= 0 ? "+" : "") + percent.toFixed(2) + "%";
    const ratio = (price / ENTRY_PRICE).toFixed(2);
    let tag = "";
    if (price >= SELL_PRICE) tag = " <<< TAKE PROFIT";
    else if (price <= STOP_LOSS_PRICE) tag = " <<< STOP LOSS";

    console.log(
      `[${ts()}] ${token_info.symbol} | $${market_info.price_usd} | ${pct} | ${ratio}x${tag}`
    );

    if (price >= SELL_PRICE || price <= STOP_LOSS_PRICE) {
      await executeSell(token_info.token_id);
    }
  } catch (err) {
    console.error(`[${ts()}] Error:`, err.message);
  }
}

function ts() {
  return new Date().toLocaleTimeString();
}

poll();
setInterval(poll, POLL_MS);
