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
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const POOL_KEY = new PublicKey(
  process.env.BOOST_POOL ?? "HAUeLaBj5T3r1wvEsAW7AgukKLzVL5peXScF2Z4pU88M",
);

function pda(seed, ...keys) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...keys.map((k) => k.toBuffer())],
    PROGRAM_ID,
  )[0];
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const random = Keypair.generate();
  const idl = JSON.parse(fs.readFileSync("idl/pump_amm.json", "utf8"));
  const program = new Program(
    idl,
    new AnchorProvider(connection, new Wallet(random), { commitment: "confirmed" }),
  );
  const pool = await program.account.pool.fetch(POOL_KEY);
  const globalConfig = pda("global_config");
  const eventAuthority = pda("__event_authority");
  const boostVaultAuthority = pda("boost_vault", POOL_KEY);
  const quoteMintInfo = await connection.getAccountInfo(pool.quoteMint, "confirmed");
  if (!quoteMintInfo) throw new Error("quote mint unavailable");
  const boostVault = getAssociatedTokenAddressSync(
    pool.quoteMint,
    boostVaultAuthority,
    true,
    quoteMintInfo.owner,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Existing funded system account used only inside simulateTransaction.
  // No transaction is broadcast by this probe.
  const feePayer = new PublicKey("FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF");
  const feeInfo = await connection.getAccountInfo(feePayer, "confirmed");
  if (!feeInfo || !feeInfo.owner.equals(SystemProgram.programId)) throw new Error("bad simulation payer");

  async function simulate(label, creator) {
    const ix = await program.methods
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
        quoteTokenProgram: quoteMintInfo.owner,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        eventAuthority,
        program: PROGRAM_ID,
      })
      .instruction();
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const result = await connection.simulateTransaction(tx, {
      commitment: "confirmed",
      sigVerify: false,
      innerInstructions: true,
    });
    return {
      label,
      creator: creator.toBase58(),
      creatorLamports: (await connection.getAccountInfo(creator, "confirmed"))?.lamports ?? 0,
      err: result.value.err,
      unitsConsumed: result.value.unitsConsumed ?? null,
      innerInstructions: result.value.innerInstructions ?? null,
      logs: result.value.logs ?? [],
    };
  }

  const results = [
    await simulate("pool_creator", pool.creator),
    await simulate("random_unfunded_creator", random.publicKey),
    await simulate("funded_unrelated_creator", feePayer),
  ];
  console.log("INIT_BOOST_CREATOR_PROBE_START");
  console.log(JSON.stringify({
    pool: POOL_KEY.toBase58(),
    poolCreator: pool.creator.toBase58(),
    virtualQuoteReserves: pool.virtualQuoteReserves.toString(),
    boostVault: boostVault.toBase58(),
    results,
  }, null, 2));
  console.log("INIT_BOOST_CREATOR_PROBE_END");
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exitCode = 1;
});
