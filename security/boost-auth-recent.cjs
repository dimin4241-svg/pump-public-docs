const fs = require("node:fs");
const { AnchorProvider, Program, Wallet } = require("@coral-xyz/anchor");
const BN = require("bn.js");
const bs58mod = require("bs58");
const bs58 = bs58mod.default ?? bs58mod;
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
const BOOST_BUY_AND_BURN_DISC = Buffer.from([105, 68, 6, 175, 0, 7, 35, 162]);
const U64_MAX = new BN("18446744073709551615");

function pda(seed, ...extra) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...extra.map((x) => x.toBuffer())],
    PROGRAM_ID,
  )[0];
}

function readTokenAmount(info) {
  if (!info || !info.data || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

function classify(sim) {
  if (sim.value.err === null) return "SUCCESS";
  const text = `${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`;
  for (const needle of [
    "ConstraintAddress", "ConstraintHasOne", "ConstraintSigner", "ConstraintRaw",
    "NotAuthorized", "Unauthorized", "AccountNotInitialized", "BoostDisabled",
    "PoolCannotBoost", "ExceededSlippage", "InsufficientRealQuoteReserves",
  ]) {
    if (text.includes(needle)) return needle;
  }
  return "UNCLASSIFIED_FAILURE";
}

function sameDisc(data) {
  try {
    const raw = bs58.decode(data);
    return raw.length >= 8 && Buffer.from(raw.subarray(0, 8)).equals(BOOST_BUY_AND_BURN_DISC);
  } catch {
    return false;
  }
}

async function main() {
  if (!RPC.includes("mainnet") && process.env.ALLOW_CUSTOM_RPC !== "1") {
    throw new Error("Safety stop: expected mainnet read/simulation RPC");
  }

  const idl = JSON.parse(fs.readFileSync("idl/pump_amm.json", "utf8"));
  const connection = new Connection(RPC, "confirmed");
  const ephemeral = Keypair.generate();
  const provider = new AnchorProvider(connection, new Wallet(ephemeral), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const globalConfigKey = pda("global_config");
  const eventAuthority = pda("__event_authority");
  const globalConfig = await program.account.globalConfig.fetch(globalConfigKey);
  const configuredBoostAuthority = globalConfig.boostAuthority;

  console.log(`Configured boost authority: ${configuredBoostAuthority.toBase58()}`);
  const sigRows = await connection.getSignaturesForAddress(
    configuredBoostAuthority,
    { limit: 100 },
    "confirmed",
  );
  console.log(`Recent authority signatures: ${sigRows.length}`);

  const recentBoostCalls = [];
  for (let start = 0; start < sigRows.length; start += 20) {
    const batch = sigRows.slice(start, start + 20);
    const txs = await connection.getParsedTransactions(
      batch.map((x) => x.signature),
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    );
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      if (!tx) continue;
      for (const ix of tx.transaction.message.instructions) {
        if (!("data" in ix) || !("accounts" in ix)) continue;
        if (!ix.programId.equals(PROGRAM_ID) || !sameDisc(ix.data)) continue;
        recentBoostCalls.push({
          signature: batch[i].signature,
          slot: tx.slot,
          accounts: ix.accounts.map((x) => x.toBase58()),
        });
      }
    }
  }
  console.log(`Recent boost_buy_and_burn calls: ${recentBoostCalls.length}`);

  const seen = new Set();
  const candidates = [];
  let target = null;
  for (const call of recentBoostCalls) {
    if (call.accounts.length < 11) continue;
    const poolKey = new PublicKey(call.accounts[0]);
    if (seen.has(poolKey.toBase58())) continue;
    seen.add(poolKey.toBase58());

    const pool = await program.account.pool.fetch(poolKey).catch(() => null);
    if (!pool) continue;
    const baseMintInfo = await connection.getAccountInfo(pool.baseMint, "confirmed");
    const quoteMintInfo = await connection.getAccountInfo(pool.quoteMint, "confirmed");
    if (!baseMintInfo || !quoteMintInfo) continue;

    const derivedAuthority = pda("boost_vault", poolKey);
    const derivedVault = getAssociatedTokenAddressSync(
      pool.quoteMint,
      derivedAuthority,
      true,
      quoteMintInfo.owner,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const transactionVault = new PublicKey(call.accounts[8]);
    const vaultInfo = await connection.getAccountInfo(transactionVault, "confirmed");
    const amount = readTokenAmount(vaultInfo);
    const row = {
      pool: poolKey.toBase58(),
      signature: call.signature,
      slot: call.slot,
      transactionBoostVault: transactionVault.toBase58(),
      derivedBoostVault: derivedVault.toBase58(),
      derivationMatches: transactionVault.equals(derivedVault),
      boostVaultExists: Boolean(vaultInfo),
      boostVaultAmount: amount.toString(),
      virtualQuoteReserves: pool.virtualQuoteReserves?.toString?.() ?? null,
    };
    candidates.push(row);
    console.log(JSON.stringify(row));
    if (vaultInfo && amount > 0n && transactionVault.equals(derivedVault)) {
      target = {
        call,
        poolKey,
        pool,
        boostVaultAuthority: derivedAuthority,
        boostVault: transactionVault,
        vaultAmount: amount,
        baseTokenProgram: baseMintInfo.owner,
        quoteTokenProgram: quoteMintInfo.owner,
      };
      break;
    }
  }

  if (!target) {
    console.log("BOOST_RECENT_DISCOVERY_JSON_START");
    console.log(JSON.stringify({ configuredBoostAuthority: configuredBoostAuthority.toBase58(), candidates }, null, 2));
    console.log("BOOST_RECENT_DISCOVERY_JSON_END");
    throw new Error("No current non-empty boost vault found among recent boost_buy_and_burn pools");
  }

  const quoteAmount = target.vaultAmount > 1_000_000n ? 1_000_000n : target.vaultAmount;
  let feePayer = globalConfig.admin;
  const feePayerInfo = await connection.getAccountInfo(feePayer, "confirmed");
  if (!feePayerInfo || !feePayerInfo.owner.equals(SystemProgram.programId) || feePayerInfo.lamports < 1_000_000) {
    throw new Error("Global admin cannot serve as simulation-only fee payer");
  }

  async function build(authority, minBaseAmountBurned) {
    return program.methods
      .boostBuyAndBurn(new BN(quoteAmount.toString()), minBaseAmountBurned)
      .accountsPartial({
        pool: target.poolKey,
        authority,
        globalConfig: globalConfigKey,
        baseMint: target.pool.baseMint,
        quoteMint: target.pool.quoteMint,
        poolBaseTokenAccount: target.pool.poolBaseTokenAccount,
        poolQuoteTokenAccount: target.pool.poolQuoteTokenAccount,
        boostVaultAuthority: target.boostVaultAuthority,
        boostVault: target.boostVault,
        baseTokenProgram: target.baseTokenProgram,
        quoteTokenProgram: target.quoteTokenProgram,
        eventAuthority,
        program: PROGRAM_ID,
      })
      .instruction();
  }

  async function simulate(label, authority, minBurn) {
    const ix = await build(authority, minBurn);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const result = await connection.simulateTransaction(tx, { commitment: "confirmed", sigVerify: false });
    return {
      label,
      authority: authority.toBase58(),
      minBaseAmountBurned: minBurn.toString(),
      classification: classify(result),
      err: result.value.err,
      unitsConsumed: result.value.unitsConsumed ?? null,
      logs: result.value.logs ?? [],
    };
  }

  const randomAuthority = ephemeral.publicKey;
  const results = [
    await simulate("configured_min0", configuredBoostAuthority, new BN(0)),
    await simulate("random_min0", randomAuthority, new BN(0)),
    await simulate("configured_minmax", configuredBoostAuthority, U64_MAX),
    await simulate("random_minmax", randomAuthority, U64_MAX),
  ];

  const output = {
    rpc: RPC,
    configuredBoostAuthority: configuredBoostAuthority.toBase58(),
    randomAuthority: randomAuthority.toBase58(),
    pool: target.poolKey.toBase58(),
    sourceSignature: target.call.signature,
    sourceSlot: target.call.slot,
    boostVault: target.boostVault.toBase58(),
    boostVaultBalance: target.vaultAmount.toString(),
    quoteAmount: quoteAmount.toString(),
    virtualQuoteReserves: target.pool.virtualQuoteReserves?.toString?.() ?? null,
    candidates,
    results,
  };
  console.log("BOOST_AUTH_FINAL_JSON_START");
  console.log(JSON.stringify(output, null, 2));
  console.log("BOOST_AUTH_FINAL_JSON_END");

  if (results[0].classification === "SUCCESS" && results[1].classification === "SUCCESS") {
    console.error("VERDICT: MISSING_AUTH_CONFIRMED");
    process.exitCode = 2;
  } else if (results[0].classification === "SUCCESS" && results[1].classification !== "SUCCESS") {
    console.log("VERDICT: AUTH_GUARD_PRESENT_OR_OTHER_AUTHORITY_SPECIFIC_REJECTION");
  } else if (
    results[0].classification === results[1].classification &&
    results[0].unitsConsumed === results[1].unitsConsumed
  ) {
    console.log("VERDICT: SAME_PATH_FAILURE — compare exact logs; no authority-specific rejection observed");
  } else {
    console.log("VERDICT: INCONCLUSIVE");
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
