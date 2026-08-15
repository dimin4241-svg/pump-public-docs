import {PublicKey, Transaction, TransactionInstruction} from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const POOL = new PublicKey('GExgczEhUbdNr3V7txqvGrJPu6nt5mbgHXtWFnX8CXeF');
const BASE_MINT = new PublicKey('GdoKrGpaXc6jfrvf9ungdgzKyT1skAro4tk5c9oTpump');
const QUOTE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const POOL_BASE = new PublicKey('EicGBXGjABiPzHaKApYQ6RQyykW5ajNX2WY3mNfCtwKe');
const POOL_QUOTE = new PublicKey('52UD2WqtcznSoGNjKCcGxQ9KxpYbAD5HTCcr5iMJvUKh');
const BOOST_VAULT_AUTH = new PublicKey('6CjqtX3gFTYzsMBacdGmDK1tzvGmApiHasVKd6BMwsMH');
const BOOST_VAULT = new PublicKey('6Zb2NXg1vDQMDJZkQwo9uR5otMLPwC86R7DF8Yz45FiT');
const QUOTE_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const ASSOCIATED = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const EVENT_AUTH = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const BOOST_AUTH = new PublicKey('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r');
const ARBITRARY = new PublicKey('2jLNDZf3QVdAm7wZiR333ZUpAnNcGV7zkYVxGdXFBB3J');
const INIT_DISC = Buffer.from('8ce9215e845ac28f','hex');
const WATCH = [POOL, GLOBAL, POOL_QUOTE, BOOST_VAULT];

async function rpc(method, params) {
  for (let attempt=0; attempt<9; attempt++) {
    const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    if(r.status===429){await new Promise(x=>setTimeout(x,1000+attempt*900));continue;}
    const j=await r.json(); if(j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
  }
  throw new Error(`${method}: retry exhausted`);
}
function initIx(creator){
  return new TransactionInstruction({programId:PROGRAM,data:INIT_DISC,keys:[
    {pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},
    {pubkey:creator,isSigner:true,isWritable:true},{pubkey:BASE_MINT,isSigner:false,isWritable:false},
    {pubkey:QUOTE_MINT,isSigner:false,isWritable:false},{pubkey:POOL_BASE,isSigner:false,isWritable:false},
    {pubkey:POOL_QUOTE,isSigner:false,isWritable:true},{pubkey:BOOST_VAULT_AUTH,isSigner:false,isWritable:false},
    {pubkey:BOOST_VAULT,isSigner:false,isWritable:true},{pubkey:QUOTE_TOKEN_PROGRAM,isSigner:false,isWritable:false},
    {pubkey:SYSTEM,isSigner:false,isWritable:false},{pubkey:ASSOCIATED,isSigner:false,isWritable:false},
    {pubkey:EVENT_AUTH,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false},
  ]});
}
function bufFromAccount(a){return a?.data?.[0] ? Buffer.from(a.data[0],'base64') : null;}
function tokenAmount(b){return b && b.length>=72 ? b.readBigUInt64LE(64).toString() : null;}
function i128le(b,off){if(!b||b.length<off+16)return null;const lo=b.readBigUInt64LE(off);const hi=b.readBigInt64LE(off+8);return (hi*(1n<<64n)+lo).toString();}
function poolDecoded(b){if(!b)return null;return {len:b.length,disc:b.subarray(0,8).toString('hex'),virtualQuoteReserves:i128le(b,245)};}
function digest(b){
  if(!b)return null;
  let h=2166136261>>>0;for(const x of b){h^=x;h=Math.imul(h,16777619)>>>0;}return h.toString(16).padStart(8,'0');
}
function diffs(a,b){
  if(!a&&!b)return [];
  if(!a||!b)return [{kind:a?'removed':'created',beforeLen:a?.length??null,afterLen:b?.length??null}];
  const out=[];let start=null;
  const n=Math.max(a.length,b.length);
  for(let i=0;i<n;i++){
    const same=i<a.length&&i<b.length&&a[i]===b[i];
    if(!same&&start===null)start=i;
    if((same||i===n-1)&&start!==null){const end=same?i-1:i;out.push({start,end,before:a.subarray(start,Math.min(end+1,a.length)).toString('hex'),after:b.subarray(start,Math.min(end+1,b.length)).toString('hex')});start=null;}
  }
  return out;
}
async function fetchBefore(){
  const r=await rpc('getMultipleAccounts',[WATCH.map(x=>x.toBase58()),{encoding:'base64',commitment:'processed'}]);
  return r.value;
}
async function simulate(ixs,feePayer){
  const bh=await rpc('getLatestBlockhash',[{commitment:'processed'}]);
  const tx=new Transaction({feePayer,recentBlockhash:bh.value.blockhash});tx.add(...ixs);
  const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
  const result=await rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'processed',accounts:{encoding:'base64',addresses:WATCH.map(x=>x.toBase58())}}]);
  const v=result.value||{};const logs=v.logs||[];return {err:v.err,units:v.unitsConsumed,logs,accounts:v.accounts||[]};
}
function analyze(label,before,sim){
  const names=['pool','global_config','pool_quote','boost_vault'];
  const accountDiff={};
  for(let i=0;i<names.length;i++){
    const pre=bufFromAccount(before[i]);const post=bufFromAccount(sim.accounts[i]);
    accountDiff[names[i]]={
      preExists:!!before[i],postExists:!!sim.accounts[i],preOwner:before[i]?.owner??null,postOwner:sim.accounts[i]?.owner??null,
      preLamports:before[i]?.lamports??null,postLamports:sim.accounts[i]?.lamports??null,
      preDigest:digest(pre),postDigest:digest(post),byteDiffs:diffs(pre,post),
    };
    if(names[i]==='pool'){accountDiff[names[i]].preDecoded=poolDecoded(pre);accountDiff[names[i]].postDecoded=poolDecoded(post);}
    if(names[i]==='pool_quote'||names[i]==='boost_vault'){accountDiff[names[i]].preTokenAmount=tokenAmount(pre);accountDiff[names[i]].postTokenAmount=tokenAmount(post);}
  }
  const text=sim.logs.join('\n');
  return {label,err:sim.err,units:sim.units,initCount:sim.logs.filter(x=>x.includes('Instruction: InitBoost')).length,pumpSuccessCount:sim.logs.filter(x=>x===`Program ${PROGRAM.toBase58()} success`).length,ataCreateCount:sim.logs.filter(x=>x.includes('Program log: Create')).length,ataCreateIdempotentCount:sim.logs.filter(x=>x.includes('CreateIdempotent')).length,anchorErrors:sim.logs.filter(x=>x.includes('AnchorError')),accountDiff,logs:sim.logs};
}
async function main(){
  const before=await fetchBefore();
  console.log('PRE',JSON.stringify({pool:poolDecoded(bufFromAccount(before[0])),poolQuoteAmount:tokenAmount(bufFromAccount(before[2])),boostVaultExists:!!before[3],boostVaultAmount:tokenAmount(bufFromAccount(before[3]))},null,2));
  const cases=[
    ['arbitrary_once',[initIx(ARBITRARY)],ARBITRARY],
    ['boost_authority_once',[initIx(BOOST_AUTH)],BOOST_AUTH],
    ['arbitrary_then_boost_authority',[initIx(ARBITRARY),initIx(BOOST_AUTH)],ARBITRARY],
    ['arbitrary_twice',[initIx(ARBITRARY),initIx(ARBITRARY)],ARBITRARY],
  ];
  const out=[];
  for(const [label,ixs,payer] of cases){
    let sim;try{sim=await simulate(ixs,payer);}catch(e){out.push({label,rpcError:String(e)});continue;}
    const a=analyze(label,before,sim);out.push(a);console.log('CASE',JSON.stringify(a,null,2));
  }
  const once=out.find(x=>x.label==='arbitrary_once');
  const twice=out.find(x=>x.label==='arbitrary_then_boost_authority');
  let verdict='INCONCLUSIVE';
  if(once && once.err===null){
    const stateChanged=['pool','global_config','pool_quote'].some(n=>once.accountDiff?.[n]?.preDigest!==once.accountDiff?.[n]?.postDigest);
    const vaultCreated=once.accountDiff?.boost_vault?.preExists===false && once.accountDiff?.boost_vault?.postExists===true;
    if(!stateChanged && vaultCreated && twice?.err===null) verdict='PERMISSIONLESS_IDEMPOTENT_EMPTY_VAULT_CREATION_NO_CORE_STATE_CHANGE';
    else if(!stateChanged && vaultCreated && twice?.err!==null) verdict='PERMISSIONLESS_PRECREATION_BLOCKS_SECOND_INIT';
    else if(stateChanged) verdict='PERMISSIONLESS_INIT_MUTATES_CORE_STATE';
  }
  console.log('FINAL_VERDICT',verdict);
  console.log('SUMMARY',JSON.stringify({verdict,cases:out.map(x=>({label:x.label,err:x.err??x.rpcError,initCount:x.initCount,pumpSuccessCount:x.pumpSuccessCount,anchorErrors:x.anchorErrors,coreDiffs:x.accountDiff?{pool:x.accountDiff.pool.byteDiffs,global:x.accountDiff.global_config.byteDiffs,poolQuote:x.accountDiff.pool_quote.byteDiffs,vault:x.accountDiff.boost_vault.byteDiffs}:null}))},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
