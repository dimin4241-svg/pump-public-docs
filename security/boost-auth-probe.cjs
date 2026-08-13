const fs = require("node:fs");
const { AnchorProvider, Program, Wallet } = require("@coral-xyz/anchor");
const BN = require("bn.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const POOL_KEY = new PublicKey(
  process.env.BOOST_POOL ?? "J5qbay91WVMCpnBmDHMqQ789LVR3ENTuEkttp4669tZJ",
);
const U64_MAX = new BN("18446744073709551615");

function pda(seed, ...extra) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...extra.map((x) => x.toBuffer())],
    PROGRAM_ID,
  )[0];
}

function normalize(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (BN.isBN(value)) return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

function classify(sim) {
  if (sim.value.err === null) return "SUCCESS";
  const text = `${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`;
  const needles = [
    "ConstraintAddress",
    "ConstraintHasOne",
    "ConstraintSigner",
    "ConstraintRaw",
    "NotAuthorized",
    "Unauthorized",
    "BoostDisabled",
    "PoolCannotBoost",
    "ExceededSlippage",
    "InsufficientRealQuoteReserves",
    "custom program error: 0x7dc",
    "custom program error: 0x7d1",
    "custom program error: 0x7d2",
  ];
  return needles.find((needle) => text.includes(needle)) ?? "UNCLASSIFIED_FAILURE";
}

async function main() {
  // Read-only security probe: no sendTransaction/sendRawTransaction exists here.
  if (!RPC.includes("mainnet") && process.env.ALLOW_CUSTOM_RPC !== "1") {
    throw new Error("Safety stop: expected mainnet read/simulation RPC");
  }

  const idl = JSON.parse(fs.readFileSync("idl/pump_amm.json", "utf8"));
  if (idl.address !== PROGRAM_ID.toBase58()) throw new Error(`IDL address mismatch: ${idl.address}`);

  const connection = new Connection(RPC, "confirmed");
  const ephemeral = Keypair.generate();
  const provider = new AnchorProvider(connection, new Wallet(ephemeral), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const globalConfigKey = pda("global_config");
  const eventAuthority = pda("__event_authority");
  const pool = await program.account.pool.fetch(POOL_KEY);
  const globalConfig = await program.account.globalConfig.fetch(globalConfigKey);

  const baseMintInfo = await connection.getAccountInfo(pool.baseMint, "confirmed");
  const quoteMintInfo = await connection.getAccountInfo(pool.quoteMint, "confirmed");
  if (!baseMintInfo || !quoteMintInfo) throw new Error("Mint account missing");
  const baseTokenProgram = baseMintInfo.owner;
  const quoteTokenProgram = quoteMintInfo.owner;

  const boostVaultAuthority = pda("boost_vault", POOL_KEY);
  const boostVault = getAssociatedTokenAddressSync(
    pool.quoteMint,
    boostVaultAuthority,
    true,
    quoteTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const boostVaultBalance = await connection.getTokenAccountBalance(boostVault, "confirmed").catch(() => null);

  const configuredBoostAuthority = globalConfig.boostAuthority;
  if (!(configuredBoostAuthority instanceof PublicKey)) {
    throw new Error("GlobalConfig.boostAuthority was not decoded as a PublicKey");
  }

  const candidates = [
    globalConfig.admin,
    ...(globalConfig.protocolFeeRecipients ?? []),
    pool.creator,
    pool.coinCreator,
  ].filter((x) => x instanceof PublicKey);

  let simulationFeePayer = null;
  for (const candidate of candidates) {
    const info = await connection.getAccountInfo(candidate, "confirmed");
    if (info && info.owner.equals(SystemProgram.programId) && info.lamports > 1_000_000) {
      simulationFeePayer = candidate;
      break;
    }
  }
  if (!simulationFeePayer) throw new Error("No funded system account available as simulation-only fee payer");

  async function build(authority, minBaseAmountBurned) {
    return program.methods
      .boostBuyAndBurn(new BN(1), minBaseAmountBurned)
      .accountsPartial({
        pool: POOL_KEY,
        authority,
        globalConfig: globalConfigKey,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        poolBaseTokenAccount: pool.poolBaseTokenAccount,
        poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
        boostVaultAuthority,
        boostVault,
        baseTokenProgram,
        quoteTokenProgram,
        eventAuthority,
        program: PROGRAM_ID,
      })
      .instruction();
  }

  async function simulate(label, authority, minBaseAmountBurned) {
    const ix = await build(authority, minBaseAmountBurned);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: simulationFeePayer,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const result = await connection.simulateTransaction(tx, {
      commitment: "confirmed",
      sigVerify: false,
    });
    return {
      label,
      authority: authority.toBase58(),
      minBaseAmountBurned: minBaseAmountBurned.toString(),
      classification: classify(result),
      err: result.value.err,
      unitsConsumed: result.value.unitsConsumed ?? null,
      logs: result.value.logs ?? [],
    };
  }

  const randomAuthority = ephemeral.publicKey;
  if (randomAuthority.equals(configuredBoostAuthority)) throw new Error("Random authority collision");

  const results = [];
  results.push(await simulate("configured_authority_min0", configuredBoostAuthority, new BN(0)));
  results.push(await simulate("random_authority_min0", randomAuthority, new BN(0)));
  results.push(await simulate("configured_authority_minmax", configuredBoostAuthority, U64_MAX));
  results.push(await simulate("random_authority_minmax", randomAuthority, U64_MAX));

  const out = {
    rpc: RPC,
    programId: PROGRAM_ID.toBase58(),
    pool: POOL_KEY.toBase58(),
    probeAuthority: randomAuthority.toBase58(),
    configuredBoostAuthority: configuredBoostAuthority.toBase58(),
    simulationFeePayer: simulationFeePayer.toBase58(),
    poolState: {
      creator: pool.creator.toBase58(),
      baseMint: pool.baseMint.toBase58(),
      quoteMint: pool.quoteMint.toBase58(),
      virtualQuoteReserves: pool.virtualQuoteReserves?.toString?.() ?? null,
    },
    boostVault: boostVault.toBase58(),
    boostVaultBalance: boostVaultBalance?.value?.amount ?? null,
    results,
  };

  console.log("BOOST_AUTH_PROBE_JSON_START");
  console.log(JSON.stringify(normalize(out), null, 2));
  console.log("BOOST_AUTH_PROBE_JSON_END");

  const configured = results[0];
  const random = results[1];
  if (configured.classification === "SUCCESS" && random.classification === "SUCCESS") {
    console.error("VERDICT: MISSING_AUTH_CONFIRMED — configured and unrelated authority both simulate successfully.");
    process.exitCode = 2;
  } else if (
    configured.classification === "SUCCESS" &&
    [
      "ConstraintAddress",
      "ConstraintHasOne",
      "ConstraintRaw",
      "NotAuthorized",
      "Unauthorized",
      "custom program error: 0x7dc",
      "custom program error: 0x7d1",
    ].includes(random.classification)
  ) {
    console.log("VERDICT: AUTH_GUARD_CONFIRMED — unrelated authority is rejected while configured authority succeeds.");
  } else {
    console.log("VERDICT: INCONCLUSIVE — inspect paired logs and minmax controls.");
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
