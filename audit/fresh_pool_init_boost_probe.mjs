import {
  PublicKey, Transaction, TransactionInstruction, SystemProgram
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT_AUTH = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const SYSTEM = SystemProgram.programId;
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const INIT_DISC = Buffer.from('8ce9215e845ac28f','hex');
// Ordinary canonical pool shown by PumpSwap's own public README with virtual_quote_reserves=0.
const POOL = new PublicKey('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
// Unrelated funded public account used only as a simulated signer/payer. No signature is verified and nothing is broadcast.
const FALLBACK_PAYER = new PublicKey('2jLNDZf3QVdAm7wZiR333ZUpAnNcGV7zkYVxGdXFBB3J');

async function rpc(method, params) {
  for (let i=0;i<9;i++) {
    const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    if(r.status===429){await new Promise(x=>setTimeout(x,1000+i*900));continue;}
    const j=await r.json(); if(j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
  }
  throw new Error(`${method}: retry exhausted`);
}
function pk(b){return new PublicKey(b).toBase58();}
function i128le(b,o){const lo=b.readBigUInt64LE(o);const hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo;}
function decodePoolAccount(value){
  if(!value) throw new Error('pool account missing');
  const b=Buffer.from(value.data[0],'base64');
  if(b.length<261) throw new Error(`pool too short: ${b.length}`);
  return {
    dataLen:b.length, discriminator:b.subarray(0,8).toString('hex'),
    bump:b[8], index:b.readUInt16LE(9), creator:pk(b.subarray(11,43)),
    baseMint:pk(b.subarray(43,75)), quoteMint:pk(b.subarray(75,107)),
    lpMint:pk(b.subarray(107,139)), poolBase:pk(b.subarray(139,171)), poolQuote:pk(b.subarray(171,203)),
    lpSupply:b.readBigUInt64LE(203).toString(), coinCreator:pk(b.subarray(211,243)),
    isMayhem:Boolean(b[243]), isCashback:Boolean(b[244]),
    virtualQuoteReserves: b.length>=261 ? i128le(b,245).toString() : '0',
  };
}
function decodeToken(value){
  if(!value) return {exists:false};
  const b=Buffer.from(value.data[0],'base64');
  return {exists:true,owner:value.owner,lamports:value.lamports,dataLen:b.length,
    mint:b.length>=72?pk(b.subarray(0,32)):null,tokenOwner:b.length>=72?pk(b.subarray(32,64)):null,
    amount:b.length>=72?b.readBigUInt64LE(64).toString():null};
}
function initIx(p, creator, vaultAuth, vault){
  return new TransactionInstruction({programId:PROGRAM,data:INIT_DISC,keys:[
    {pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},
    {pubkey:creator,isSigner:true,isWritable:true},{pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},
    {pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},
    {pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},{pubkey:vaultAuth,isSigner:false,isWritable:false},
    {pubkey:vault,isSigner:false,isWritable:true},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:SYSTEM,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:EVENT_AUTH,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false},
  ]});
}
async function choosePayer(minLamports=300_000_000n){
  const candidates=[FALLBACK_PAYER];
  const sigs=await rpc('getSignaturesForAddress',[PROGRAM.toBase58(),{limit:100,commitment:'confirmed'}]);
  for(const s of sigs||[]){
    if(s.err) continue;
    try{
      const tx=await rpc('getTransaction',[s.signature,{encoding:'json',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
      const k=tx?.transaction?.message?.accountKeys?.[0]; if(k) candidates.push(new PublicKey(k));
    }catch{}
    if(candidates.length>30) break;
  }
  for(const c of candidates){
    try{
      const bal=BigInt((await rpc('getBalance',[c.toBase58(),{commitment:'confirmed'}])).value);
      const info=(await rpc('getAccountInfo',[c.toBase58(),{encoding:'base64',commitment:'confirmed'}])).value;
      if(bal>=minLamports && info?.owner===SYSTEM.toBase58()) return {pubkey:c,balance:bal.toString()};
    }catch{}
  }
  throw new Error('no sufficiently funded simulated system-account payer found');
}
async function getAccounts(keys){return (await rpc('getMultipleAccounts',[keys.map(x=>x.toBase58()),{encoding:'base64',commitment:'processed'}])).value;}
async function simulate(ixs,feePayer,watch){
  const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;
  const tx=new Transaction({feePayer,recentBlockhash:bh}); tx.add(...ixs);
  const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
  return (await rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'processed',accounts:{encoding:'base64',addresses:watch.map(x=>x.toBase58())}}])).value;
}
function summarize(v){
  const logs=v?.logs||[]; const text=logs.join('\n');
  return {err:v?.err??null,units:v?.unitsConsumed??null,
    initCount:logs.filter(x=>x.includes('Instruction: InitBoost')).length,
    constraintAddress:text.includes('ConstraintAddress'),invalidAdmin:text.includes('InvalidAdmin'),
    anchorErrors:logs.filter(x=>x.includes('AnchorError')),logs};
}
async function main(){
  const poolInfo=(await rpc('getAccountInfo',[POOL.toBase58(),{encoding:'base64',commitment:'processed'}])).value;
  const p=decodePoolAccount(poolInfo);
  console.log('POOL',JSON.stringify(p,null,2));
  if(p.quoteMint!==WSOL.toBase58()) throw new Error(`expected WSOL quote, got ${p.quoteMint}`);
  if(BigInt(p.virtualQuoteReserves)!==0n) throw new Error(`control pool already initialized for virtual reserves: ${p.virtualQuoteReserves}`);

  const [vaultAuth,bump]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),POOL.toBuffer()],PROGRAM);
  const vault=getAssociatedTokenAddressSync(WSOL,vaultAuth,true,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID);
  const payerInfo=await choosePayer(); const payer=payerInfo.pubkey;
  const creator=new PublicKey(p.creator);
  console.log('DERIVED',JSON.stringify({vaultAuth:vaultAuth.toBase58(),vaultAuthBump:bump,vault:vault.toBase58(),payer:payer.toBase58(),payerBalance:payerInfo.balance,creator:creator.toBase58()},null,2));

  const watch=[POOL,new PublicKey(p.poolQuote),vault];
  const pre=await getAccounts(watch);
  console.log('PRE',JSON.stringify({pool:decodePoolAccount(pre[0]),poolQuote:decodeToken(pre[1]),vault:decodeToken(pre[2])},null,2));

  // 1) True initialization path with unrelated signer and no prefunding.
  const a=await simulate([initIx(p,payer,vaultAuth,vault)],payer,watch);
  console.log('ARBITRARY_EMPTY_INIT',JSON.stringify({summary:summarize(a),post:{pool:a.accounts?.[0]?decodePoolAccount(a.accounts[0]):null,poolQuote:decodeToken(a.accounts?.[1]),vault:decodeToken(a.accounts?.[2])}},null,2));

  // 2) Same true path with the Pool.creator marked as signer, but unrelated funded fee payer.
  const b=await simulate([initIx(p,creator,vaultAuth,vault)],payer,watch);
  console.log('POOL_CREATOR_EMPTY_INIT',JSON.stringify({summary:summarize(b),post:{pool:b.accounts?.[0]?decodePoolAccount(b.accounts[0]):null,poolQuote:decodeToken(b.accounts?.[1]),vault:decodeToken(b.accounts?.[2])}},null,2));

  // 3) Permissionlessly create the canonical WSOL vault, pre-fund it with 0.1 SOL, SyncNative, then call init_boost.
  const fund=100_000_000;
  const preFundIxs=[
    createAssociatedTokenAccountIdempotentInstruction(payer,vault,vaultAuth,WSOL,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID),
    SystemProgram.transfer({fromPubkey:payer,toPubkey:vault,lamports:fund}),
    createSyncNativeInstruction(vault,TOKEN_PROGRAM_ID),
    initIx(p,payer,vaultAuth,vault),
  ];
  const c=await simulate(preFundIxs,payer,watch);
  console.log('ARBITRARY_PREFUNDED_INIT',JSON.stringify({fundLamports:fund,summary:summarize(c),post:{pool:c.accounts?.[0]?decodePoolAccount(c.accounts[0]):null,poolQuote:decodeToken(c.accounts?.[1]),vault:decodeToken(c.accounts?.[2])}},null,2));

  // 4) Control: identical prefunded setup but use actual pool.creator as creator signer.
  const d=await simulate([
    createAssociatedTokenAccountIdempotentInstruction(payer,vault,vaultAuth,WSOL,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID),
    SystemProgram.transfer({fromPubkey:payer,toPubkey:vault,lamports:fund}),
    createSyncNativeInstruction(vault,TOKEN_PROGRAM_ID),
    initIx(p,creator,vaultAuth,vault),
  ],payer,watch);
  console.log('POOL_CREATOR_PREFUNDED_INIT',JSON.stringify({fundLamports:fund,summary:summarize(d),post:{pool:d.accounts?.[0]?decodePoolAccount(d.accounts[0]):null,poolQuote:decodeToken(d.accounts?.[1]),vault:decodeToken(d.accounts?.[2])}},null,2));

  const cases={arbitraryEmpty:a,poolCreatorEmpty:b,arbitraryPrefunded:c,poolCreatorPrefunded:d};
  const result={pool:p,derived:{vaultAuth:vaultAuth.toBase58(),vault:vault.toBase58(),payer:payer.toBase58(),creator:creator.toBase58()},simulationOnly:true,broadcast:false,cases:{}};
  for(const [name,v] of Object.entries(cases)) result.cases[name]={summary:summarize(v),postPool:v.accounts?.[0]?decodePoolAccount(v.accounts[0]):null,postVault:decodeToken(v.accounts?.[2])};
  console.log('RESULT',JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
