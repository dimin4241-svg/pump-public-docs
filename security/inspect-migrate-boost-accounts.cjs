const fs = require('node:fs');
const { Connection, PublicKey } = require('@solana/web3.js');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SIG = process.env.MIGRATE_SIG || 'dX8PkFMB874eCG9qV8gZJmEtZYmNDW8zggUju7UXBKG8u9yoBDMNZBH7Rfbqh2ZDGsCTUvETjvwZizJLpRZF97c';
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const MIGRATE_V2 = Buffer.from([187,203,18,31,206,237,254,41]);
const INIT_BOOST = Buffer.from([140,233,33,94,132,90,194,143]);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(s) {
  let bytes = [0];
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error('bad base58');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 255; carry >>= 8; }
    while (carry) { bytes.push(carry & 255; carry >>= 8; }
  }
  for (let k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}
function matches(data, disc) { try { const b = b58decode(data); return b.length >= 8 && b.subarray(0,8).equals(disc); } catch { return false; } }
function dataInfo(ix) {
  if (!('data' in ix)) return null;
  try {
    const b = b58decode(ix.data);
    return { len:b.length, prefix8:b.subarray(0,8).toString('hex'), base64:b.toString('base64') };
  } catch { return null; }
}

function flattenIdlAccounts(accounts, prefix='') {
  const out = [];
  for (const a of accounts || []) {
    if (a.accounts) out.push(...flattenIdlAccounts(a.accounts, `${prefix}${a.name}.`));
    else out.push(`${prefix}${a.name}`);
  }
  return out;
}

async function main() {
  if (!RPC.includes('mainnet') && process.env.ALLOW_CUSTOM_RPC !== '1') throw new Error('read-only mainnet RPC expected');
  const pumpIdl = JSON.parse(fs.readFileSync('idl/pump.json','utf8'));
  const ammIdl = JSON.parse(fs.readFileSync('idl/pump_amm.json','utf8'));
  const migrateDef = pumpIdl.instructions.find(x => x.name === 'migrate_v2');
  const initDef = ammIdl.instructions.find(x => x.name === 'init_boost');
  if (!migrateDef || !initDef) throw new Error('IDL instructions missing');
  const migrateNames = flattenIdlAccounts(migrateDef.accounts);
  const initNames = flattenIdlAccounts(initDef.accounts);

  const c = new Connection(RPC, 'confirmed');
  const tx = await c.getParsedTransaction(SIG, { commitment:'confirmed', maxSupportedTransactionVersion:0 });
  if (!tx) throw new Error('transaction unavailable');

  const outer = tx.transaction.message.instructions;
  const migrateIndex = outer.findIndex(ix => 'data' in ix && ix.programId.equals(PUMP) && matches(ix.data, MIGRATE_V2));
  if (migrateIndex < 0) throw new Error('migrate_v2 outer instruction not found');
  const migrateIx = outer[migrateIndex];

  const innerGroup = (tx.meta?.innerInstructions || []).find(x => x.index === migrateIndex);
  const innerInstructions = innerGroup?.instructions || [];
  const initIxs = innerInstructions.filter(ix => 'data' in ix && ix.programId.equals(AMM) && matches(ix.data, INIT_BOOST));

  const actualMigrateAccounts = migrateIx.accounts.map(x => x.toBase58());
  const named = actualMigrateAccounts.map((key, i) => ({
    index: i,
    name: i < migrateNames.length ? migrateNames[i] : `remaining_${i - migrateNames.length}`,
    key,
  }));

  const logs = tx.meta?.logMessages || [];
  const result = {
    signature: SIG,
    slot: tx.slot,
    blockTime: tx.blockTime,
    migrateOuterIndex: migrateIndex,
    migrateIdlRequiredCount: migrateNames.length,
    migrateActualCount: actualMigrateAccounts.length,
    migrateRemainingCount: Math.max(0, actualMigrateAccounts.length - migrateNames.length),
    migrateAccounts: named,
    initBoostInnerCount: initIxs.length,
    initBoostIdlRequiredCount: initNames.length,
    allInner: innerInstructions.map((ix, index) => ({
      index,
      programId: ix.programId.toBase58(),
      accountsCount: ix.accounts?.length ?? 0,
      data: dataInfo(ix),
    })),
    initBoostCalls: initIxs.map((ix, n) => ({
      n,
      actualCount: ix.accounts.length,
      accounts: ix.accounts.map((x,i) => ({index:i,name:initNames[i] || `extra_${i-initNames.length}`,key:x.toBase58()})),
    })),
    logsAroundBoost: logs.filter(x => /MigrateV2|InitBoost|BOOST|boost|Program data:/i.test(x)),
  };

  for (const call of result.initBoostCalls) {
    call.outerMigratePositions = call.accounts.map(a => ({
      initName: a.name,
      key: a.key,
      migratePositions: named.filter(m => m.key === a.key).map(m => ({index:m.index,name:m.name})),
    }));
  }

  console.log('MIGRATE_BOOST_ACCOUNT_MAP_START');
  console.log(JSON.stringify(result, null, 2));
  console.log('MIGRATE_BOOST_ACCOUNT_MAP_END');

  if (result.migrateRemainingCount > 0 && result.initBoostInnerCount > 0) {
    console.log('VERDICT: PRODUCTION_MIGRATE_V2_USED_REMAINING_ACCOUNTS_TO_SUPPORT_ATOMIC_INIT_BOOST_CPI');
  } else if (result.initBoostInnerCount > 0) {
    console.log('VERDICT: INIT_BOOST_CPI_IS_ATOMIC_WITHOUT_EXTRA_OUTER_ACCOUNTS');
  }
}
main().catch(e => { console.error(e.stack || String(e)); process.exitCode=1; });
