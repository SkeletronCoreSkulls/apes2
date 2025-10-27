import 'dotenv/config';
import { ethers } from 'ethers';

const {
  RPC_URL,
  USDC_ADDRESS,
  TREASURY_ADDRESS,
  NFT_CONTRACT_ADDRESS,
  OWNER_PRIVATE_KEY,
  X402_VERSION,
  X402_RESOURCE,
  X402_PRICE_USDC,
  X402_NETWORK,
  X402_ASSET,
  X402_MAX_TIMEOUT_SECONDS
} = process.env;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = OWNER_PRIVATE_KEY ? new ethers.Wallet(OWNER_PRIVATE_KEY, provider) : null;

const ERC20_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const NFT_ABI = ['function mintAfterPayment(address payer, uint256 quantity) external', 'function owner() view returns (address)'];

const nft = NFT_CONTRACT_ADDRESS && wallet
  ? new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, wallet)
  : null;

const processedTxs = new Set();
const PRICE = BigInt(X402_PRICE_USDC || '10000000'); // 10 USDC

// Validate USDC payment and return payer
async function verifyUsdcPayment(txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error('Transaction not found');
  if (receipt.status !== 1) throw new Error('Transaction failed');

  const iface = new ethers.Interface(ERC20_ABI);
  const usdcLC = USDC_ADDRESS.toLowerCase();
  const treasLC = TREASURY_ADDRESS.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcLC) continue;
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    if (parsed.name === 'Transfer' && parsed.args.to.toLowerCase() === treasLC) {
      const value = BigInt(parsed.args.value.toString());
      if (value >= PRICE) return ethers.getAddress(parsed.args.from);
    }
  }
  throw new Error('No valid USDC payment found');
}

// Build schema for x402scan
function x402Response() {
  return {
    x402Version: Number(X402_VERSION || 1),
    accepts: [
      {
        scheme: "exact",
        network: X402_NETWORK || "base",
        maxAmountRequired: PRICE.toString(),
        resource: X402_RESOURCE || "mint:x402apes:1",
        description: "Mint one x402Apes NFT automatically after USDC payment confirmation.",
        mimeType: "application/json",
        payTo: TREASURY_ADDRESS,
        maxTimeoutSeconds: Number(X402_MAX_TIMEOUT_SECONDS || 600),
        asset: X402_ASSET || "USDC",
        outputSchema: {
          input: { type: "http", method: "POST", bodyType: "json" },
          output: { ok: true, mintedTo: "0x...", nftTxHash: "0x...", note: "Mint completed." }
        },
        extra: { autoConfirm: true, onePerPayment: true, project: "x402Apes" }
      }
    ]
  };
}

// ✅ Handler
export default async function handler(req, res) {
  try {
    // x402scan discovery → respond 402 with schema
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      return res.status(402).json(x402Response());
    }

    // x402scan notify → confirm payment automatically
    if (req.method === 'POST') {
      const { txHash } = req.body || {};
      if (!txHash) return res.status(400).json({ error: 'Missing txHash from x402' });
      if (processedTxs.has(txHash)) return res.status(200).json({ ok: true, note: 'Already processed', txHash });

      const payer = await verifyUsdcPayment(txHash);
      const tx = await nft.mintAfterPayment(payer, 1, { gasLimit: 300000n });
      const receipt = await tx.wait();

      processedTxs.add(txHash);
      return res.status(200).json({
        ok: true,
        mintedTo: payer,
        nftTxHash: receipt.hash,
        note: 'Minted automatically after USDC payment confirmation.'
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({
      x402Version: Number(X402_VERSION || 1),
      error: err?.message || 'Internal server error'
    });
  }
}
