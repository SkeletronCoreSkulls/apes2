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
const NFT_ABI  = [
  'function mintAfterPayment(address payer, uint256 quantity) external',
  'function owner() view returns (address)',
  'function mintEnabled() view returns (bool)',
  'function totalMinted() view returns (uint256)',
  'function maxSupply() view returns (uint256)'
];

const nft = (NFT_CONTRACT_ADDRESS && wallet)
  ? new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, wallet)
  : null;

const processedTxs = new Set();
const PRICE = BigInt(X402_PRICE_USDC || '10000000'); // 10 USDC por defecto (6 decimales)

function x402Response(payer) {
  return {
    x402Version: Number(X402_VERSION || 1),
    ...(payer ? { payer } : {}),
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
        // sin input fields → la UI no pedirá nada
        outputSchema: {
          input: { type: "http", method: "POST", bodyType: "json" },
          output: { ok: true, mintedTo: "0x...", nftTxHash: "0x...", note: "Mint completed." }
        },
        extra: { autoConfirm: true, onePerPayment: true, project: "x402Apes" }
      }
    ]
  };
}

// -------- helpers --------
function topicForAddress(addr) {
  // address -> 32 bytes topic
  return ethers.zeroPadValue(ethers.getAddress(addr), 32);
}

async function findLatestUsdcPaymentTxHash(payer) {
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const fromTopic = topicForAddress(payer);
  const toTopic   = topicForAddress(TREASURY_ADDRESS);

  const latest = await provider.getBlockNumber();
  // ventana de búsqueda: ~50k bloques recientes (ajustable)
  const fromBlock = Math.max(0, latest - 50_000);

  const logs = await provider.getLogs({
    address: USDC_ADDRESS,
    fromBlock,
    toBlock: latest,
    topics: [transferTopic, fromTopic, toTopic]
  });

  if (!logs.length) throw new Error('No recent USDC payment from payer to treasury');
  // Tomamos el último (más reciente)
  const last = logs[logs.length - 1];
  return last.transactionHash;
}

async function verifyUsdcPayment(txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error('Transaction not found');
  if (receipt.status !== 1) throw new Error('Transaction failed');

  const iface = new ethers.Interface(ERC20_ABI);
  const usdcLC = USDC_ADDRESS.toLowerCase();
  const treasLC = TREASURY_ADDRESS.toLowerCase();

  let payer = null;
  let paid  = 0n;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcLC) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === 'Transfer' && parsed.args.to.toLowerCase() === treasLC) {
        paid += BigInt(parsed.args.value.toString());
        if (!payer) payer = parsed.args.from;
      }
    } catch {}
  }
  if (!payer) throw new Error('No USDC Transfer to TREASURY found in tx');
  if (paid < PRICE) throw new Error(`Insufficient amount: paid=${paid} required=${PRICE}`);
  return ethers.getAddress(payer);
}

// -------- handler --------
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // si x402 pasa ?payer=0x..., lo exponemos (opcional)
      const payer = typeof req.query.payer === 'string' ? req.query.payer : undefined;
      res.setHeader('Content-Type', 'application/json');
      return res.status(402).json(x402Response(payer));
    }

    if (req.method === 'POST') {
      if (!wallet || !nft) {
        return res.status(500).json({ x402Version: Number(X402_VERSION || 1), error: 'Server misconfigured: missing OWNER_PRIVATE_KEY or NFT_CONTRACT_ADDRESS' });
      }

      // 1) txHash directo si viene (preferido)
      let { txHash } = req.body || {};
      let payerHint =
        (req.headers['x-402-payer'] && String(req.headers['x-402-payer'])) ||
        (typeof req.query.payer === 'string' ? req.query.payer : undefined);

      // 2) si no vino txHash, inferirlo buscando el último pago del payer → treasury
      if (!txHash) {
        if (!payerHint) return res.status(400).json({ error: 'Missing txHash and payer; cannot infer payment' });
        txHash = await findLatestUsdcPaymentTxHash(payerHint);
      }

      if (processedTxs.has(txHash)) {
        return res.status(200).json({ ok: true, note: 'Already processed', txHash });
      }

      // 3) verify + mint
      const payer = await verifyUsdcPayment(txHash);

      // pre-check ownership para evitar revert silencioso
      const onchainOwner = await nft.owner();
      if (onchainOwner.toLowerCase() !== wallet.address.toLowerCase()) {
        return res.status(400).json({
          x402Version: Number(X402_VERSION || 1),
          error: 'Misconfiguration: signer is not contract owner',
          details: { onchainOwner, signer: wallet.address, contract: NFT_CONTRACT_ADDRESS }
        });
      }

      const tx = await nft.mintAfterPayment(payer, 1, { gasLimit: 300000n });
      const rec = await tx.wait();

      processedTxs.add(txHash);
      return res.status(200).json({
        ok: true,
        mintedTo: payer,
        nftTxHash: rec.hash,
        note: 'Minted automatically after USDC payment confirmation.'
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({
      x402Version: Number(X402_VERSION || 1),
      error: err?.message || 'Internal error'
    });
  }
}
