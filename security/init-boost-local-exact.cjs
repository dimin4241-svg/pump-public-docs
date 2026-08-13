const fs = require("node:fs");
const { AnchorProvider, Program, Wallet } = require("@coral-xyz/anchor");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const POOL_KEY = new PublicKey(
  process.env.BOOST_POOL ?? "J5qbay91WVMCpnBmDHMqQ789LVR3ENTuEkttp4669tZJ",
);

function pda(seed, ...extra) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...extra.map((x) => x.toBuffer())],
    PROGRAM_ID,
  )[0];
}

function classify(result) {
  if (result.value.err === null) return "SUCCESS";
  const text = `${JSON.stringify(result.value.err)}\n${(result.value.logs ?? []).join("\n")}`;
  const needles = [
    "InvalidAdmin",
    "ConstraintAddress",
    "ConstraintHasOne",
    "ConstraintRaw",
    "ConstraintSigner",
    "Unauthorized",
    "NotAuthorized",
    "PoolCannotBoost",
    "BoostDisabled",
    "AccountNotInitialized",
    "AccountAlreadyInitialized",
    "AssociatedTokenAccount",
  ];
  return needles.find((x) => text.includes(x)) ?? "UNCLASSIFIED_FAILURE";
}

async function airdrop(connection, pubkey, lamports) {
  const sig = await connection.requestAirdrop(pubkey, lamports);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
}

async function main() {
  if (!RPC.includes("127.0.0.1") && !RPC.includes("localhost")) {
    throw new Error(`Safety stop: this probe must only run against a local validator, got ${RPC}`);
  }

  const connection = new Connection(RPC, "confirmed");
  const idl = JSON.parse(fs.readFileSync("idl/pump_amm.json", "utf8"));
  if (idl.address !== PROGRAM_ID.toBase58()) throw new Error("IDL program mismatch");

  const ephemeral = Keypair.generate();
  const provider = new AnchorProvider(connection, new Wallet(ephemeral), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const globalConfig = pda("global_config");
  const eventAuthority = pda("__event_authority");
  const pool = await program.account.pool.fetch(POOL_KEY);
  const trueCreator = pool.creator;

  const trueCreatorBalance = await connection.getBalance(trueCreator, "confirmed");
  if (trueCreatorBalance < 5_000_000) {
    throw new Error(
      `fixture creator ${trueCreator.toBase58()} is not locally funded; balance=${trueCreatorBalance}`,
    );
  }

  const randomCreator = Keypair.generate();
  await airdrop(connection, randomCreator.publicKey, 10_000_000_000);

  const baseMintInfo = await connection.getAccountInfo(pool.baseMint, "confirmed");
  const quoteMintInfo = await connection.getAccountInfo(pool.quoteMint, "confirmed");
  if (!baseMintInfo || !quoteMintInfo) throw new Error("fixture mint account missing");
  const quoteTokenProgram = quoteMintInfo.owner;

  const boostVaultAuthority = pda("boost_vault", POOL_KEY);
  const boostVault = getAssociatedTokenAddressSync(
    pool.quoteMint,
    boostVaultAuthority,
    true,
    quoteTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const boostVaultBefore = await connection.getAccountInfo(boostVault, "confirmed");

  async function build(creator) {
    return program.methods
      .initBoost()
      .accountsPartial({
        pool: POOL_KEY,
        globalConfig,
        creator,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        poolBaseTokenAccount: pool.poolBaseTokenAccount,
        poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
        boostVaultAuthority,
        boostVault,
        quoteTokenProgram,
        systemProgram: new PublicKey("11111111111111111111111111111111"),
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        eventAuthority,
        program: PROGRAM_ID,
      })
      .instruction();
  }

  async function simulate(label, creator) {
    const ix = await build(creator);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: creator,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    // Local-only differential: bypass Ed25519 verification so we can exercise
    // the exact deployed program with the real historical creator pubkey. The
    // signer bit in the instruction remains set for both cases.
    const result = await connection.simulateTransaction(tx, {
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    return {
      label,
      creator: creator.toBase58(),
      classification: classify(result),
      err: result.value.err,
      unitsConsumed: result.value.unitsConsumed ?? null,
      logs: result.value.logs ?? [],
    };
  }

  const correct = await simulate("pool_creator", trueCreator);
  const random = await simulate("unrelated_creator", randomCreator.publicKey);

  const output = {
    rpc: RPC,
    programId: PROGRAM_ID.toBase58(),
    pool: POOL_KEY.toBase58(),
    poolCreator: trueCreator.toBase58(),
    poolCreatorLocalBalance: trueCreatorBalance,
    unrelatedCreator: randomCreator.publicKey.toBase58(),
    boostVault: boostVault.toBase58(),
    boostVaultExistsBefore: Boolean(boostVaultBefore),
    virtualQuoteReserves: pool.virtualQuoteReserves?.toString?.() ?? null,
    correct,
    random,
  };

  console.log("INIT_BOOST_LOCAL_DIFFERENTIAL_START");
  console.log(JSON.stringify(output, null, 2));
  console.log("INIT_BOOST_LOCAL_DIFFERENTIAL_END");

  if (correct.classification === "SUCCESS" && random.classification === "SUCCESS") {
    console.error("VERDICT: CREATOR_AUTH_MISSING_CONFIRMED");
    process.exitCode = 2;
  } else if (correct.classification === "SUCCESS" && random.classification !== "SUCCESS") {
    console.log("VERDICT: CREATOR_SPECIFIC_GUARD_CONFIRMED");
  } else if (
    correct.classification === random.classification &&
    correct.unitsConsumed === random.unitsConsumed &&
    JSON.stringify(correct.err) === JSON.stringify(random.err)
  ) {
    console.log("VERDICT: SAME_PATH_FAILURE_AFTER_RENT_BARRIER");
  } else {
    console.log("VERDICT: DIFFERENTIAL_PRESENT_INSPECT_LOGS");
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
});
