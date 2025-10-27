# x402Apes – Single-file x402 endpoint (Vercel-ready)

This project exposes **one single API route** required by x402scan:
- **GET /api/402** → returns the strict `X402Response` schema for resource discovery.
- **POST /api/402** → processes a paid call: verifies a USDC transfer to your treasury on Base and mints **1 NFT** to the **payer** by calling `mintAfterPayment(payer, 1)` on your contract.

## Deploy steps
1. Put these Environment Variables in Vercel (Project → Settings → Environment Variables):
   - `RPC_URL=https://mainnet.base.org`
   - `CHAIN_ID=8453`
   - `USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
   - `TREASURY_ADDRESS=0x8096194Fdc121D16424bc6A9DD9f445Caa4EE4c8`
   - `NFT_CONTRACT_ADDRESS=<your deployed contract>`
   - `OWNER_PRIVATE_KEY=<owner private key>`
   - `X402_VERSION=1`
   - `X402_RESOURCE=mint:x402apes:1`
   - `X402_NETWORK=base`
   - `X402_ASSET=USDC`
   - `X402_MAX_TIMEOUT_SECONDS=600`
   - `X402_PRICE_USDC=10000000` (10 USDC, or set to 0 if purely informational)

2. Push this folder to GitHub and connect the repo to Vercel (Framework Preset: **Other**, Node.js **20+**).

## Local quick check
Vercel recommends `vercel dev` for serverless. You can also mimic a POST using cURL to your deployed URL:

```bash
curl -X POST "https://<your-app>.vercel.app/api/402"   -H "Content-Type: application/json"   --data '{"resource":"mint:x402apes:1","txHash":"0x<usdc-transfer-hash>"}'
```

## Contract
Use `contract/x402Apes.sol` (Solidity 0.8.24, EVM Paris). Only the **owner** can mint, and **always to the payer**.
