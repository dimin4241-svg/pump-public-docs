const fs = require('node:fs');
const { AnchorProvider, Program, Wallet } = require('@coral-xyz/anchor');
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require('@solana/web3.js');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const POOL = new PublicKey(process.env.BOOST_POOL || 'J5qbay91WVMCpnBmDHMqQ789LVR3ENTuEkttp4669tZJ');
const SOURCE_MIGRATION = process.env.SOURCE_MIGRATION || 'dX8PkFMB874eCG9qV8gZJmEtZYmNDW8zggUju7UXBKG8u9yoBDMNZBH7Rfbqh2ZDGsCTUvETjvwZizJLpRZF97c';

function pda(seed, ...keys) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...keys.map(k => k.toBuffer())],
    AMM,
  )[0];
}

function tokenAmount(info) {
  if (!info) return null;
  let data = info.data;
  if (Array.isArray(data)) data = Buffer.from(data[0], 'base64');
  if (typeof data === 'string') data = Buffer.from(data, 'base64');
  if (data && !Buffer.isBuffer(data) && data.data) data = Buffer.from(data.data);
  if (!Buffer.isBuffer(data) || data.length < 72) return null;
  return data.readBigUInt64LE(64).toString();
}

function accountData(info) {
  if (!info) return null;
  let data = info.data;
  if (Array.isArray(data)) return Buffer.from(data[0], 'base64');
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  if (Buffer.isBuffer(data)) return data;
  if (data && data.data) return Buffer.from(data.data);
  return null;
}

function normalize(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    if (value.constructor && value.constructor.name === 'BN' && value.toString) return value.toString();
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, normalize(v)]));
  }
  return value;
}

function classify(idl, sim) {
  if (sim.value.err === null) return 'SUCCESS';
  const logs = sim.value.logs || [];
  const text = logs.join('\n');
  const anchor = text.match(/Error Code: ([A-Za-z0-9_]+)/);
  if (anchor) return anchor[1];
  const n = sim.value.err?.InstructionError?.[1]?.Custom;
  if (typeof n === 'number') {
    return (idl.errors || []).find(e => e.code === n)?.name || `Custom(${n})`;
  }
  return 'UNCLASSIFIED_FAILURE';
}

async function fundedUnrelatedSigner(connection, tx, excluded) {
  for (const row of tx.transaction.message.accountKeys) {
    if (!row.signer) continue;
    const key = row.pubkey;
    if (excluded.has(key.toBase58())) continue;
    const info = await connection.getAccountInfo(key, 'confirmed');
    if (info && info.owner.equals(SystemProgram.programId) && info.lamports >= 5_000_000) {
      return { key, lamports: info.lamports, source: 'historical_migration_signer' };
    }
  }
  return null;
}

async function main() {
  if (!RPC.includes('mainnet') && process.env.ALLOW_CUSTOM_RPC !== '1') {
    throw new Error('Safety stop: read-only mainnet simulation RPC expected');
  }

  const idl = JSON.parse(fs.readFileSync('idl/pump_amm.json', 'utf8'));
  const connection = new Connection(RPC, 'confirmed');
  const ephemeral = Keypair.generate();
  const provider = new AnchorProvider(connection, new Wallet(ephemeral), { commitment: 'confirmed' });
  const program = new Program(idl, provider);

  const globalKey = pda('global_config');
  const eventAuthority = pda('__event_authority');
  const global = await program.account.globalConfig.fetch(globalKey);
  const pool = await program.account.pool.fetch(POOL);

  const quoteMintInfo = await connection.getAccountInfo(pool.quoteMint, 'confirmed');
  if (!quoteMintInfo) throw new Error('quote mint unavailable');
  const quoteTokenProgram = quoteMintInfo.owner;
  const boostVaultAuthority = pda('boost_vault', POOL);
  const boostVault = getAssociatedTokenAddressSync(
    pool.quoteMint,
    boostVaultAuthority,
    true,
    quoteTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const prePoolInfo = await connection.getAccountInfo(POOL, 'confirmed');
  const preQuoteInfo = await connection.getAccountInfo(pool.poolQuoteTokenAccount, 'confirmed');
  const preBoostInfo = await connection.getAccountInfo(boostVault, 'confirmed');

  const migrationTx = await connection.getParsedTransaction(SOURCE_MIGRATION, {
    commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  });
  if (!migrationTx) throw new Error('source migration transaction unavailable');

  const excluded = new Set([
    pool.creator.toBase58(),
    global.admin.toBase58(),
    global.boostAuthority.toBase58(),
    pool.coinCreator?.toBase58?.() || '',
  ]);
  let arbitrary = await fundedUnrelatedSigner(connection, migrationTx, excluded);

  if (!arbitrary) {
    for (const key of global.protocolFeeRecipients || []) {
      if (excluded.has(key.toBase58())) continue;
      const info = await connection.getAccountInfo(key, 'confirmed');
      if (info && info.owner.equals(SystemProgram.programId) && info.lamports >= 5_000_000) {
        arbitrary = { key, lamports: info.lamports, source: 'protocol_fee_recipient_fallback' };
        break;
      }
    }
  }
  if (!arbitrary) throw new Error('could not locate a funded unrelated system signer for simulation');

  async function simulate(label, creator, payer) {
    const ix = await program.methods.initBoost().accountsPartial({
      pool: POOL,
      globalConfig: globalKey,
      creator,
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      poolBaseTokenAccount: pool.poolBaseTokenAccount,
      poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
      boostVaultAuthority,
      boostVault,
      quoteTokenProgram,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      eventAuthority,
      program: AMM,
    }).instruction();

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);

    // READ-ONLY: no sendTransaction/sendRawTransaction exists in this script.
    // sigVerify=false lets us test program key-equality/authorization logic without
    // possessing the unrelated account's private key; signer metas remain intact.
    const sim = await connection.simulateTransaction(tx, {
      commitment: 'confirmed',
      sigVerify: false,
      accounts: {
        encoding: 'base64',
        addresses: [
          POOL.toBase58(),
          pool.poolQuoteTokenAccount.toBase58(),
          boostVault.toBase58(),
        ],
      },
    });

    let postPool = null;
    const postPoolData = accountData(sim.value.accounts?.[0]);
    if (postPoolData) {
      try { postPool = program.coder.accounts.decode('Pool', postPoolData); } catch {}
    }

    return {
      label,
      creator: creator.toBase58(),
      payer: payer.toBase58(),
      classification: classify(idl, sim),
      err: sim.value.err,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      post: {
        virtualQuoteReserves: postPool?.virtualQuoteReserves?.toString?.() ?? null,
        poolQuoteAmount: tokenAmount(sim.value.accounts?.[1]),
        boostVaultExists: Boolean(sim.value.accounts?.[2]),
        boostVaultAmount: tokenAmount(sim.value.accounts?.[2]),
      },
      logs: sim.value.logs || [],
    };
  }

  // The pool creator is a Pump PDA, so this control cannot be signed in a normal
  // top-level transaction. It is still useful as a behavior baseline under
  // sigVerify=false. The unrelated funded system account models a real user key.
  const control = await simulate('expected_pool_creator_pda_control', pool.creator, arbitrary.key);
  const unrelated = await simulate('funded_unrelated_system_signer', arbitrary.key, arbitrary.key);

  const output = {
    rpc: RPC,
    programId: AMM.toBase58(),
    pool: POOL.toBase58(),
    poolCreator: pool.creator.toBase58(),
    arbitrarySigner: {
      key: arbitrary.key.toBase58(),
      lamports: arbitrary.lamports,
      source: arbitrary.source,
    },
    configuredBoostAuthority: global.boostAuthority.toBase58(),
    boostEnabled: global.boostEnabled,
    poolStateBefore: {
      virtualQuoteReserves: pool.virtualQuoteReserves?.toString?.() ?? null,
      poolQuoteAmount: tokenAmount(preQuoteInfo),
      boostVault: boostVault.toBase58(),
      boostVaultExists: Boolean(preBoostInfo),
      boostVaultAmount: tokenAmount(preBoostInfo),
      poolAccountExists: Boolean(prePoolInfo),
    },
    results: [control, unrelated],
  };

  console.log('INIT_BOOST_REINIT_FUNDED_START');
  console.log(JSON.stringify(normalize(output), null, 2));
  console.log('INIT_BOOST_REINIT_FUNDED_END');

  if (unrelated.err === null) {
    console.error('VERDICT: UNRELATED_FUNDED_SIGNER_CAN_REINIT_BOOST_ON_EXISTING_POOL_IN_READ_ONLY_SIMULATION');
    process.exitCode = 2;
  } else if (unrelated.classification !== control.classification || unrelated.unitsConsumed !== control.unitsConsumed) {
    console.log('VERDICT: DIFFERENTIAL_REJECTION_OBSERVED — inspect logs for an authority-specific guard');
  } else {
    console.log('VERDICT: SAME_PATH_FOR_EXPECTED_AND_UNRELATED_CREATOR — no creator-specific rejection observed before common failure');
  }
}

main().catch(e => { console.error(e.stack || String(e)); process.exitCode = 1; });
