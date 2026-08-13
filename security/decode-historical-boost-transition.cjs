const { Connection, PublicKey } = require('@solana/web3.js');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SIGNATURE = 'dX8PkFMB874eCG9qV8gZJmEtZYmNDW8zggUju7UXBKG8u9yoBDMNZBH7Rfbqh2ZDGsCTUvETjvwZizJLpRZF97c';
const AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const EVENT_CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const CREATE_POOL_EVENT = Buffer.from([177,49,12,210,160,118,167,116]);
const INIT_BOOST_EVENT = Buffer.from([174,124,74,249,4,81,246,17]);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(s) {
  let bytes = [0];
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error('bad base58');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 255; carry >>= 8; }
    while (carry) { bytes.push(carry & 255); carry >>= 8; }
  }
  for (let k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}
function b58encode(data) {
  let n = BigInt('0x' + Buffer.from(data).toString('hex'));
  let out = '';
  while (n > 0n) { const r = Number(n % 58n); n /= 58n; out = ALPHABET[r] + out; }
  let zeros = 0;
  for (const x of data) { if (x === 0) zeros++; else break; }
  return '1'.repeat(zeros) + out;
}
function i128le(buf) {
  let n = 0n;
  for (let i = 15; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]);
  if (n & (1n << 127n)) n -= 1n << 128n;
  return n;
}
function pub(raw, state) { const x = b58encode(raw.subarray(state.o, state.o + 32)); state.o += 32; return x; }
function u64(raw, state) { const x = raw.readBigUInt64LE(state.o); state.o += 8; return x; }

function decodeCreatePool(raw) {
  if (raw.length !== 342 || !raw.subarray(0,8).equals(EVENT_CPI) || !raw.subarray(8,16).equals(CREATE_POOL_EVENT)) return null;
  const s = {o:16};
  const timestamp = Number(raw.readBigInt64LE(s.o)); s.o += 8;
  const index = raw.readUInt16LE(s.o); s.o += 2;
  const creator = pub(raw,s), baseMint = pub(raw,s), quoteMint = pub(raw,s);
  const baseMintDecimals = raw[s.o++], quoteMintDecimals = raw[s.o++];
  const baseAmountIn = u64(raw,s), quoteAmountIn = u64(raw,s), poolBaseAmount = u64(raw,s), poolQuoteAmount = u64(raw,s);
  const minimumLiquidity = u64(raw,s), initialLiquidity = u64(raw,s), lpTokenAmountOut = u64(raw,s);
  const poolBump = raw[s.o++];
  const pool = pub(raw,s), lpMint = pub(raw,s), userBaseTokenAccount = pub(raw,s), userQuoteTokenAccount = pub(raw,s), coinCreator = pub(raw,s);
  const isMayhemMode = Boolean(raw[s.o++]);
  return { timestamp,index,creator,baseMint,quoteMint,baseMintDecimals,quoteMintDecimals,baseAmountIn:baseAmountIn.toString(),quoteAmountIn:quoteAmountIn.toString(),poolBaseAmount:poolBaseAmount.toString(),poolQuoteAmount:poolQuoteAmount.toString(),minimumLiquidity:minimumLiquidity.toString(),initialLiquidity:initialLiquidity.toString(),lpTokenAmountOut:lpTokenAmountOut.toString(),poolBump,pool,lpMint,userBaseTokenAccount,userQuoteTokenAccount,coinCreator,isMayhemMode };
}
function decodeInitBoost(raw) {
  if (raw.length !== 144 || !raw.subarray(0,8).equals(EVENT_CPI) || !raw.subarray(8,16).equals(INIT_BOOST_EVENT)) return null;
  const s = {o:16};
  const timestamp = Number(raw.readBigInt64LE(s.o)); s.o += 8;
  const mint = pub(raw,s), bondingCurve = pub(raw,s), pool = pub(raw,s);
  const virtualQuoteReserves = i128le(raw.subarray(s.o,s.o+16)); s.o += 16;
  const realQuoteReservesAfter = u64(raw,s);
  return {timestamp,mint,bondingCurve,pool,virtualQuoteReserves:virtualQuoteReserves.toString(),realQuoteReservesAfter:realQuoteReservesAfter.toString()};
}

async function main() {
  const c = new Connection(RPC, 'confirmed');
  const tx = await c.getParsedTransaction(SIGNATURE, {commitment:'confirmed',maxSupportedTransactionVersion:0});
  if (!tx) throw new Error('transaction unavailable');
  const events = [];
  for (const group of tx.meta?.innerInstructions || []) {
    for (const ix of group.instructions || []) {
      if (!('data' in ix) || !ix.programId.equals(AMM)) continue;
      const raw = b58decode(ix.data);
      const create = decodeCreatePool(raw);
      if (create) events.push({kind:'CreatePoolEvent',...create});
      const boost = decodeInitBoost(raw);
      if (boost) events.push({kind:'InitBoostEvent',...boost});
    }
  }
  const create = events.find(e => e.kind === 'CreatePoolEvent');
  const boost = events.find(e => e.kind === 'InitBoostEvent');
  const invariant = create && boost ? {
    quoteBeforeInitBoost: create.poolQuoteAmount,
    realQuoteAfterInitBoost: boost.realQuoteReservesAfter,
    virtualQuoteReserves: boost.virtualQuoteReserves,
    realRemoved: (BigInt(create.poolQuoteAmount) - BigInt(boost.realQuoteReservesAfter)).toString(),
    realRemovedEqualsVirtual: BigInt(create.poolQuoteAmount) - BigInt(boost.realQuoteReservesAfter) === BigInt(boost.virtualQuoteReserves),
    effectiveQuotePreserved: BigInt(boost.realQuoteReservesAfter) + BigInt(boost.virtualQuoteReserves) === BigInt(create.poolQuoteAmount),
  } : null;
  console.log('HISTORICAL_BOOST_TRANSITION_START');
  console.log(JSON.stringify({signature:SIGNATURE,slot:tx.slot,blockTime:tx.blockTime,events,invariant}, null, 2));
  console.log('HISTORICAL_BOOST_TRANSITION_END');
}
main().catch(e => { console.error(e.stack || String(e)); process.exitCode=1; });
