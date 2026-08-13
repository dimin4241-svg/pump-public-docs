const fs = require('node:fs');
const BN = require('bn.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.default ?? bs58mod;
const {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} = require('@solana/web3.js');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const WITHDRAW = new PublicKey(process.env.WITHDRAW_AUTHORITY || '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');
const MIGRATE_V2 = Buffer.from([187,203,18,31,206,237,254,41]);
const REQUIRED_ACCOUNTS = 27;
const EXPECTED_WITH_BOOST = 29;
const SIG_LIMIT = Number(process.env.SIG_LIMIT || 160);
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 20);
const GLOBAL_ADMIN = new PublicKey('FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function discMatches(data) {
  try {
    const raw = bs58.decode(data);
    return raw.length >= 8 && Buffer.from(raw.subarray(0,8)).equals(MIGRATE_V2);
  } catch { return false; }
}

async function retry(fn, label) {
  let last;
  for (let i = 0; i < 8; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const text = String(e);
      if (!/429|Too many requests|rate/i.test(text) || i === 7) throw e;
      const wait = Math.min(8000, 500 * (2 ** i));
      console.log(`retry ${label}: ${wait}ms after rate limit`);
      await sleep(wait);
    }
  }
  throw last;
}

function findMigrateIx(tx) {
  const ixs = tx?.transaction?.message?.instructions || [];
  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    if ('data' in ix && 'accounts' in ix && ix.programId.equals(PUMP) && discMatches(ix.data)) {
      return { ix, index: i };
    }
  }
  return null;
}

function accountFlags(tx) {
  const m = new Map();
  for (const row of tx.transaction.message.accountKeys) {
    m.set(row.pubkey.toBase58(), { isSigner: !!row.signer, isWritable: !!row.writable });
  }
  return m;
}

function classify(idl, sim) {
  if (sim.value.err === null) return { name: 'SUCCESS', custom: null };
  const logs = sim.value.logs || [];
  const text = logs.join('\n');
  const match = text.match(/Error Code: ([A-Za-z0-9_]+)/);
  if (match) return { name: match[1], custom: null };
  const n = sim.value.err?.InstructionError?.[1]?.Custom;
  if (typeof n === 'number') {
    const row = (idl.errors || []).find(e => e.code === n);
    return { name: row?.name || `Custom(${n})`, custom: n };
  }
  if (text.includes('Not enough remaining accounts')) return { name: 'NotEnoughRemainingAccounts', custom: 6027 };
  return { name: 'UNCLASSIFIED_FAILURE', custom: null };
}

async function simulate(connection, idl, payer, originalIx, flags, keepCount, label) {
  const keys = originalIx.accounts.slice(0, keepCount).map(pubkey => {
    const f = flags.get(pubkey.toBase58()) || { isSigner:false, isWritable:false };
    return { pubkey, isSigner:f.isSigner, isWritable:f.isWritable };
  });
  const migrate = new TransactionInstruction({
    programId: PUMP,
    keys,
    data: Buffer.from(bs58.decode(originalIx.data)),
  });
  const { blockhash } = await retry(() => connection.getLatestBlockhash('confirmed'), `${label}:blockhash`);
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
      migrate,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const sim = await retry(() => connection.simulateTransaction(tx, {
    commitment:'confirmed',
    sigVerify:false,
  }), `${label}:simulate`);
  const c = classify(idl, sim);
  return {
    label,
    keepCount,
    classification: c.name,
    customError: c.custom,
    err: sim.value.err,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    hasInitBoost: (sim.value.logs || []).some(x => x.includes('Instruction: InitBoost')),
    hasCreatePool: (sim.value.logs || []).some(x => x.includes('Instruction: CreatePool')),
    logs: sim.value.logs || [],
  };
}

async function main() {
  if (!RPC.includes('mainnet') && process.env.ALLOW_CUSTOM_RPC !== '1') throw new Error('read-only mainnet simulation RPC expected');
  const idl = JSON.parse(fs.readFileSync('idl/pump.json','utf8'));
  const connection = new Connection(RPC, 'confirmed');

  const payerInfo = await retry(() => connection.getAccountInfo(GLOBAL_ADMIN, 'confirmed'), 'payer-info');
  if (!payerInfo || payerInfo.lamports < 2_000_000) throw new Error('simulation payer unavailable');

  const sigs = await retry(() => connection.getSignaturesForAddress(WITHDRAW, {limit:SIG_LIMIT}, 'confirmed'), 'signatures');
  console.log(`withdraw_signatures=${sigs.length}`);

  const candidateRows = [];
  let tested = 0;
  for (const sigRow of sigs) {
    if (tested >= MAX_CANDIDATES) break;
    const parsed = await retry(() => connection.getParsedTransaction(sigRow.signature, {
      commitment:'confirmed', maxSupportedTransactionVersion:0,
    }), `tx:${sigRow.signature.slice(0,8)}`);
    if (!parsed) { await sleep(250); continue; }
    const found = findMigrateIx(parsed);
    if (!found) { await sleep(250); continue; }
    const { ix } = found;
    if (ix.accounts.length < REQUIRED_ACCOUNTS) { await sleep(250); continue; }

    const pool = ix.accounts[10];
    const poolInfo = await retry(() => connection.getAccountInfo(pool, 'confirmed'), `pool:${pool.toBase58().slice(0,8)}`);
    const row = {
      sourceSignature:sigRow.signature,
      sourceSlot:sigRow.slot,
      sourceErr:parsed.meta?.err || null,
      accountCount:ix.accounts.length,
      baseMint:ix.accounts[2]?.toBase58() || null,
      pool:pool.toBase58(),
      poolCurrentlyExists:!!poolInfo,
    };
    if (poolInfo) {
      candidateRows.push({...row, skipped:'already_migrated'});
      await sleep(250);
      continue;
    }

    tested++;
    console.log(`candidate ${tested}: ${row.baseMint} pool=${row.pool} sourceErr=${JSON.stringify(row.sourceErr)}`);

    const flags = accountFlags(parsed);
    let full;
    try {
      full = await simulate(connection, idl, GLOBAL_ADMIN, ix, flags, Math.min(ix.accounts.length, EXPECTED_WITH_BOOST), `full-${tested}`);
    } catch (e) {
      candidateRows.push({...row, fullProbeError:String(e?.stack || e)});
      await sleep(700);
      continue;
    }

    // State must still be unmigrated before the differential control.
    const poolAfterFullSim = await retry(() => connection.getAccountInfo(pool, 'confirmed'), `post-full-pool:${tested}`);
    if (poolAfterFullSim) {
      candidateRows.push({...row, full, skippedAfterFull:'migrated_by_external_actor_during_probe'});
      await sleep(500);
      continue;
    }

    let bare;
    try {
      bare = await simulate(connection, idl, GLOBAL_ADMIN, ix, flags, REQUIRED_ACCOUNTS, `bare-${tested}`);
    } catch (e) {
      candidateRows.push({...row, full, bareProbeError:String(e?.stack || e)});
      await sleep(700);
      continue;
    }

    const combined = {...row, full, bare};
    candidateRows.push(combined);
    console.log('DIFFERENTIAL_CANDIDATE_START');
    console.log(JSON.stringify(combined, null, 2));
    console.log('DIFFERENTIAL_CANDIDATE_END');

    if (full.hasInitBoost && full.classification === 'SUCCESS') {
      console.log('BOOST_ELIGIBLE_LIVE_TARGET_CONFIRMED_BY_29_ACCOUNT_SIMULATION');
      if (bare.classification === 'SUCCESS') {
        console.log('VERDICT: SECURITY_CANDIDATE_CONFIRMED_27_ACCOUNT_MIGRATION_SUCCEEDS_WHILE_SKIPPING_ATOMIC_INIT_BOOST');
        process.exitCode = 2;
      } else if (bare.classification === 'NotEnoughRemainingAccounts') {
        console.log('VERDICT: SAFE_ONCHAIN_GUARD_27_ACCOUNT_MIGRATION_FAILS_ATOMICALLY_WITH_NOT_ENOUGH_REMAINING_ACCOUNTS');
      } else {
        console.log(`VERDICT: 27_ACCOUNT_PATH_REJECTED_WITH_${bare.classification}`);
      }
      console.log('LIVE_27_VS_29_SUMMARY_START');
      console.log(JSON.stringify(candidateRows, null, 2));
      console.log('LIVE_27_VS_29_SUMMARY_END');
      return;
    }

    await sleep(750);
  }

  console.log('LIVE_27_VS_29_SUMMARY_START');
  console.log(JSON.stringify(candidateRows, null, 2));
  console.log('LIVE_27_VS_29_SUMMARY_END');
  console.log('VERDICT: NO_CURRENT_UNMIGRATED_BOOST_ELIGIBLE_TARGET_REACHED_SUCCESSFULLY_IN_SAMPLE');
}

main().catch(e => { console.error(e.stack || String(e)); process.exitCode=1; });
