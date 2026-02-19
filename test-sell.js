import "dotenv/config";
import { ethers } from "ethers";

const TCG_ADDRESS = "0x94CF69B5b13E621cB11f5153724AFb58c7337777";
const LENS_ADDRESS = "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea";
const BONDING_CURVE_ROUTER = "0x6F6B8F1a20703309951a5127c45B49b1CD981A22";
const DEX_ROUTER = "0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137";
const SLIPPAGE_BPS = 300; // 3% slippage for safety on a tiny test sell

const LENS_ABI = [
  "function getAmountOut(address token, uint256 amountIn, bool isBuy) view returns (address router, uint256 amountOut)",
];
const ROUTER_ABI = [
  "function sell(tuple(uint256 amountIn, uint256 amountOutMin, address token, address to, uint256 deadline))",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const lens = new ethers.Contract(LENS_ADDRESS, LENS_ABI, provider);
const bondingRouter = new ethers.Contract(BONDING_CURVE_ROUTER, ROUTER_ABI, wallet);
const dexRouter = new ethers.Contract(DEX_ROUTER, ROUTER_ABI, wallet);

async function main() {
  console.log(`Wallet: ${wallet.address}\n`);

  const token = new ethers.Contract(TCG_ADDRESS, ERC20_ABI, wallet);
  const [symbol, decimals, balance] = await Promise.all([
    token.symbol(),
    token.decimals(),
    token.balanceOf(wallet.address),
  ]);

  console.log(`Token: ${symbol} (${decimals} decimals)`);
  console.log(`Full balance: ${ethers.formatUnits(balance, decimals)} ${symbol}`);

  if (balance === 0n) {
    console.log("\nNo TCG tokens in wallet. Nothing to sell.");
    process.exit(0);
  }

  // Sell exactly 1 token (10^decimals smallest units)
  const sellAmount = ethers.parseUnits("1", decimals);

  if (sellAmount > balance) {
    console.log(`\nBalance too low to sell 1 ${symbol}. You have ${ethers.formatUnits(balance, decimals)}`);
    process.exit(1);
  }

  console.log(`\nTest selling: 1 ${symbol}`);

  const [routerAddr, expectedOut] = await lens.getAmountOut(TCG_ADDRESS, sellAmount, false);
  const minOut = (expectedOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

  console.log(`Router: ${routerAddr}`);
  console.log(`Expected MON out: ${ethers.formatEther(expectedOut)}`);
  console.log(`Min MON out (${SLIPPAGE_BPS / 100}% slippage): ${ethers.formatEther(minOut)}`);

  const currentAllowance = await token.allowance(wallet.address, routerAddr);
  if (currentAllowance < sellAmount) {
    console.log("\nApproving tokens...");
    const approveTx = await token.approve(routerAddr, sellAmount);
    const approveReceipt = await approveTx.wait();
    console.log(`Approved — tx: ${approveTx.hash} (block ${approveReceipt.blockNumber})`);
  } else {
    console.log("\nAllowance sufficient, skipping approve.");
  }

  const router = routerAddr === BONDING_CURVE_ROUTER ? bondingRouter : dexRouter;
  const routerName = routerAddr === BONDING_CURVE_ROUTER ? "BondingCurveRouter" : "DexRouter";
  const deadline = Math.floor(Date.now() / 1000) + 300;

  console.log(`\nSelling via ${routerName}...`);

  const sellTx = await router.sell({
    amountIn: sellAmount,
    amountOutMin: minOut,
    token: TCG_ADDRESS,
    to: wallet.address,
    deadline,
  });

  console.log(`Tx submitted: ${sellTx.hash}`);
  const receipt = await sellTx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);
  console.log("\nTest sell of 1 TCG complete!");
}

main().catch((err) => {
  console.error("\nSell failed:", err.message);
  if (err.data) console.error("Revert data:", err.data);
  process.exit(1);
});
