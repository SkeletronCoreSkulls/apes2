import 'dotenv/config';
import { ethers } from 'ethers';

const {
  RPC_URL,
  CHAIN_ID,
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

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];
const NFT_ABI = [
  'function mintAfterPayment(address payer, uint256 quantity) external',
  'function owner() view returns (address)',
  'function mintEnabled() view returns (bool)',
  'function totalMinted() view returns (uint256)',
  'function maxSupply() view returns (uint256)'
];

const nft = NFT_CONTRACT_ADDRESS && wallet
  ? new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, wallet)
  : null;

const processedTxs = new Set();
const PRICE = BigInt(X402_PRICE_USDC || '10000000'); // default 10 USDC

function asChecksum(addr) { return ethers.getAddress(addr); }
function ensureAddr(name, v) {
  try { asChecksum(v); } catch { throw new Error(`Invalid address for ${name}: ${v}`); }
}
[['USDC_ADDRESS', USDC_ADDRESS], ['TREASURY_ADDRESS', TREASURY_ADDRESS], ['NFT_CONTRACT_ADDRESS', NFT_CONTRACT_ADDRESS]]
  .forEach(([n, v]) => v && ensureAddr(n, v));

async function verifyUsdcPayment(txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error('Transaction not found');
  if (receipt.status !== 1) throw new Error('Transaction failed on-chain');

  const iface = new ethers.Interface(ERC20_ABI);
  const usdcLC = USDC_ADDRESS.toLowerCase();
  const treasLC = TREASURY_ADDRESS.toLowerCase();

  let payer = null;
  let paid = 0n;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcLC) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === 'Transfer') {
        const to = parsed.args.to.toLowerCase();
        const value = BigInt(parsed.args.value.toString());
        if (to === treasLC) {
          paid += value;
          if (!payer) payer = parsed.args.from;
        }
      }
    } catch {}
  }
  if (!payer) throw new Error('No USDC Transfer to TREASURY found in tx');
  if (paid < PRICE) throw new Error(`Insufficient amount: paid=${paid} required=${PRICE}`);
  return ethers.getAddress(payer);
}

function x402Response() {
  return {
    x402Version: Number(X402_VERSION || 1),
    accepts: [
      {
        scheme: "exact",
        network: X402_NETWORK || "base",
        maxAmountRequired: (PRICE ?? 0n).toString(),
        resource: X402_RESOURCE || "mint:x402apes:1",
        description: "Mint one x402Apes NFT after a confirmed USDC payment to the treasury.",
        mimeType: "application/json",
        payTo: TREASURY_ADDRESS,
        maxTimeoutSeconds: Number(X402_MAX_TIMEOUT_SECONDS || 600),
        asset: X402_ASSET || "USDC",
        outputSchema: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            bodyFields: {
              resource: { type: "string", required: true, description: "Must match the resource identifier" },
              txHash: { type: "string", required: true, description: "USDC payment tx hash on Base" }
            }
          },
          output: {
            ok: true,
            mintedTo: "0x...",
            nftTxHash: "0x...",
            note: "Always mints exactly 1 NFT to the payer."
          }
        },
        extra: { project: "x402Apes", onePerCall: true }
      }
    ]
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // Debug mode ?debug=state → shows current signer/owner status
      if (req.query.debug === 'state' && nft && wallet) {
        const net = await provider.getNetwork();
        const info = {
          chainId: net.chainId.toString(),
          contract: NFT_CONTRACT_ADDRESS,
          signer: wallet.address,
          onchainOwner: await nft.owner(),
          mintEnabled: await nft.mintEnabled(),
          totalMinted: (await nft.totalMinted()).toString(),
          maxSupply: (await nft.maxSupply()).toString()
        };
        return res.status(200).json(info);
      }

      const resp = x402Response();
      return res.status(200).json(resp);
    }

    if (req.method === 'POST') {
      if (!wallet || !nft) throw new Error('Server misconfigured: missing OWNER_PRIVATE_KEY or NFT_CONTRACT_ADDRESS');
      const { resource, txHash } = req.body || {};
      if (!resource || !txHash) return res.status(400).json({ error: 'Missing resource or txHash' });

      if (resource !== (X402_RESOURCE || 'mint:x402apes:1')) {
        return res.status(400).json({ error: 'Invalid resource' });
      }

      if (processedTxs.has(txHash)) {
        return res.status(200).json({ ok: true, note: 'Already processed', txHash });
      }

      // --- PATCH: Pre-check signer vs owner ---
      const onchainOwner = await nft.owner();
      if (onchainOwner.toLowerCase() !== wallet.address.toLowerCase()) {
        return res.status(400).json({
          x402Version: Number(X402_VERSION || 1),
          error: 'Misconfiguration: signer is not contract owner',
          details: { onchainOwner, signer: wallet.address, contract: NFT_CONTRACT_ADDRESS }
        });
      }

      const payer = await verifyUsdcPayment(txHash);
      const tx = await nft.mintAfterPayment(payer, 1, { gasLimit: 300000n });
      const rec = await tx.wait();

      processedTxs.add(txHash);
      return res.status(200).json({
        ok: true,
        mintedTo: payer,
        nftTxHash: rec.hash,
        note: 'Minted exactly 1 NFT to payer after verified USDC payment.'
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
