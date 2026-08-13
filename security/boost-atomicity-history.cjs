const { Connection, PublicKey } = require('@solana/web3.js');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const POOL = new PublicKey(process.env.BOOST_POOL || 'J5qbay91WVMCpnBmDHMqQ789LVR3ENTuEkttp4669tZJ');
const BOOST_VAULT = new PublicKey(process.env.BOOST_VAULT || '4bFNJ6sVpqYaF8jM8n62dNdNzH6G2bRTVcf6xag6UAiJ');
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const MIGRATE_V2 = Buffer.from([187,203,18,31,206,237,254,41]);
const INIT_BOOST = Buffer.from([140,233,33,94,132,90,194,143]);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(s) {
  let bytes = [0];
  for (const c of s) {
    const value = ALPHABET.indexOf(c);
    if (value < 0) throw new Error(`bad base58 char ${c}`);
    let carry = value;
    for (let j = 0; j < bytes.length; ++j) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < s.length && s[k] === '1'; ++k) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function discEq(data, disc) {
  try {
    const raw = b58decode(data);
    return raw.length >= 8 && raw.subarray(0, 8).equals(disc);
  } catch { return false; }
}

function inspectIx(ix, out, where) {
  if (!ix || !('programId' in ix) || !('data' in ix)) return;
  const pid = ix.programId.toBase58();
  if (pid === PUMP.toBase58() && discEq(ix.data, MIGRATE_V2)) out.push({kind:'migrate_v2', where});
  if (pid === AMM.toBase58() && discEq(ix.data, INIT_BOOST)) out.push({kind:'init_boost', where});
}

async function getParsedWithRetry(connection, signature) {
  for (let i = 0; i < 7; i++) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: 'confirmed', maxSupportedTransactionVersion: 0,
      });
      return tx;
    } catch (e) {
      const text = String(e);
      if (!/429|Too many requests|rate/i.test(text) || i === 6) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

function inspectTx(tx) {
  const found = [];
  if (!tx) return found;
  tx.transaction.message.instructions.forEach((ix, i) => inspectIx(ix, found, `outer:${i}`));
  for (const group of tx.meta?.innerInstructions || []) {
    group.instructions.forEach((ix, i) => inspectIx(ix, found, `inner:${group.index}:${i}`));
  }
  const logs = tx.meta?.logMessages || [];
  if (logs.some(x => x.includes('Instruction: MigrateV2')) && !found.some(x => x.kind === 'migrate_v2')) {
    found.push({kind:'migrate_v2', where:'log'});
  }
  if (logs.some(x => x.includes('Instruction: InitBoost')) && !found.some(x => x.kind === 'init_boost')) {
    found.push({kind:'init_boost', where:'log'});
  }
  return found;
}

async function main() {
  if (!RPC.includes('mainnet') && process.env.ALLOW_CUSTOM_RPC !== '1') throw new Error('read-only mainnet RPC expected');
  const c = new Connection(RPC, 'confirmed');

  console.log(`pool=${POOL}`);
  console.log(`boost_vault=${BOOST_VAULT}`);
  const vaultSigs = await c.getSignaturesForAddress(BOOST_VAULT, {limit: 1000}, 'confirmed');
  console.log(`boost_vault_signatures=${vaultSigs.length}`);

  const vaultRows = [];
  let initRow = null;
  for (const row of vaultSigs) {
    const tx = await getParsedWithRetry(c, row.signature);
    const found = inspectTx(tx);
    if (found.length) {
      const x = {signature: row.signature, slot: row.slot, blockTime: row.blockTime, found};
      vaultRows.push(x);
      if (!initRow && found.some(y => y.kind === 'init_boost')) initRow = x;
    }
    await new Promise(r => setTimeout(r, 120));
  }

  console.log('VAULT_MATCHES_START');
  console.log(JSON.stringify(vaultRows, null, 2));
  console.log('VAULT_MATCHES_END');

  if (!initRow) {
    console.log('VERDICT: NO_INIT_BOOST_FOUND_IN_BOOST_VAULT_HISTORY');
    return;
  }

  const initSameTxMigrate = initRow.found.some(x => x.kind === 'migrate_v2');
  console.log(`init_signature=${initRow.signature}`);
  console.log(`init_slot=${initRow.slot}`);
  console.log(`init_block_time=${initRow.blockTime}`);
  console.log(`migrate_in_same_tx=${initSameTxMigrate}`);

  if (initSameTxMigrate) {
    console.log('VERDICT: MIGRATE_V2_AND_INIT_BOOST_ATOMIC_IN_OBSERVED_TX');
    return;
  }

  // Search older pool transactions immediately before init_boost. If migrate_v2
  // was separate but adjacent, it should appear here without crawling all pool trades.
  const older = await c.getSignaturesForAddress(POOL, {limit: 200, before: initRow.signature}, 'confirmed');
  console.log(`older_pool_signatures_checked=${older.length}`);
  const priorMatches = [];
  for (const row of older) {
    const tx = await getParsedWithRetry(c, row.signature);
    const found = inspectTx(tx);
    if (found.length) priorMatches.push({signature: row.signature, slot: row.slot, blockTime: row.blockTime, found});
    if (found.some(x => x.kind === 'migrate_v2')) break;
    await new Promise(r => setTimeout(r, 140));
  }
  console.log('PRIOR_MATCHES_START');
  console.log(JSON.stringify(priorMatches, null, 2));
  console.log('PRIOR_MATCHES_END');

  const migrate = priorMatches.find(x => x.found.some(y => y.kind === 'migrate_v2'));
  if (migrate) {
    console.log(`migrate_signature=${migrate.signature}`);
    console.log(`migrate_slot=${migrate.slot}`);
    console.log(`slot_gap=${initRow.slot - migrate.slot}`);
    console.log('VERDICT: MIGRATE_V2_AND_INIT_BOOST_ARE_SEPARATE_OBSERVED_TRANSACTIONS');
  } else {
    console.log('VERDICT: INIT_BOOST_SEPARATE_FROM_ITS_TX_BUT_MIGRATE_NOT_FOUND_IN_200_PRIOR_POOL_SIGNATURES');
  }
}

main().catch(e => { console.error(e.stack || String(e)); process.exitCode = 1; });
