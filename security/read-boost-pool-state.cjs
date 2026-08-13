const fs = require("node:fs");
const { AnchorProvider, Program, Wallet } = require("@coral-xyz/anchor");
const { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require("@solana/spl-token");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const POOLS = [
  "HAUeLaBj5T3r1wvEsAW7AgukKLzVL5peXScF2Z4pU88M",
  "J5qbay91WVMCpnBmDHMqQ789LVR3ENTuEkttp4669tZJ",
];

function pda(seed, key) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), key.toBuffer()], PROGRAM_ID)[0];
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const idl = JSON.parse(fs.readFileSync("idl/pump_amm.json", "utf8"));
  const kp = Keypair.generate();
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" }));
  const rows = [];
  for (const text of POOLS) {
    const poolKey = new PublicKey(text);
    const pool = await program.account.pool.fetch(poolKey);
    const quoteMintInfo = await connection.getAccountInfo(pool.quoteMint, "confirmed");
    const vaultAuthority = pda("boost_vault", poolKey);
    const vault = getAssociatedTokenAddressSync(pool.quoteMint, vaultAuthority, true, quoteMintInfo.owner, ASSOCIATED_TOKEN_PROGRAM_ID);
    const [poolQuote, boostVaultInfo] = await Promise.all([
      connection.getTokenAccountBalance(pool.poolQuoteTokenAccount, "confirmed"),
      connection.getAccountInfo(vault, "confirmed"),
    ]);
    let boostAmount = null;
    if (boostVaultInfo) {
      boostAmount = (await connection.getTokenAccountBalance(vault, "confirmed")).value.amount;
    }
    rows.push({
      pool: text,
      creator: pool.creator.toBase58(),
      baseMint: pool.baseMint.toBase58(),
      quoteMint: pool.quoteMint.toBase58(),
      lpSupply: pool.lpSupply.toString(),
      virtualQuoteReserves: pool.virtualQuoteReserves.toString(),
      poolQuoteAmount: poolQuote.value.amount,
      boostVault: vault.toBase58(),
      boostVaultExists: Boolean(boostVaultInfo),
      boostVaultAmount: boostAmount,
    });
  }
  console.log("BOOST_POOL_STATE_START");
  console.log(JSON.stringify(rows, null, 2));
  console.log("BOOST_POOL_STATE_END");
}

main().catch((e) => { console.error(e?.stack ?? e); process.exitCode = 1; });
