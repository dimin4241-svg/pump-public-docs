import fs from 'node:fs';
import bs58 from 'bs58';
import {PublicKey,Transaction,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';

const RPCS=(process.env.SOLANA_RPCS||'https://api.mainnet-beta.solana.com,https://rpc.ankr.com/solana').split(',').map(x=>x.trim()).filter(Boolean);
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT_AUTH=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const SYSTEM=SystemProgram.programId;
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
const FALLBACK_FEE_PAYER=new PublicKey('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r');
const INIT_DISC=Buffer.from([140,233,33,94,132,90,194,143]);
const idl=JSON.parse(fs.readFileSync('idl/pump_amm.json','utf8'));
const poolDef=(idl.accounts||[]).find(x=>String(x.name).toLowerCase()==='pool');
if(!poolDef?.discriminator)throw new Error('Pool discriminator missing from current IDL');
const POOL_DISC=Buffer.from(poolDef.discriminator);

let rpcUrl=RPCS[0];
async function post(url,method,params){
  for(let attempt=0;attempt<8;attempt++){
    try{
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','user-agent':'pump-authorized-bounty-sim-only/1.0'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,650+attempt*800));continue;}
      const j=await r.json();
      if(j.error)throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    }catch(e){if(attempt===7)throw e;await new Promise(x=>setTimeout(x,500+attempt*650));}
  }
}
async function chooseRpc(){
  for(const u of RPCS){
    try{const v=await post(u,'getVersion',[]);rpcUrl=u;console.log('RPC_OK',u,JSON.stringify(v));return;}
    catch(e){console.log('RPC_FAIL',u,String(e));}
  }
  throw new Error('No usable Solana RPC');
}
const rpc=(m,p)=>post(rpcUrl,m,p);
const pk=b=>new PublicKey(b).toBase58();
function i128(b,o){const lo=b.readBigUInt64LE(o),hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo;}
function decodePoolAccount(pubkey,value){
  if(!value)return null;const b=Buffer.from(value.data[0],'base64');if(b.length<261)return null;
  return {pubkey,len:b.length,disc:b.subarray(0,8).toString('hex'),index:b.readUInt16LE(9),creator:pk(b.subarray(11,43)),baseMint:pk(b.subarray(43,75)),quoteMint:pk(b.subarray(75,107)),lpMint:pk(b.subarray(107,139)),poolBase:pk(b.subarray(139,171)),poolQuote:pk(b.subarray(171,203)),lpSupply:b.readBigUInt64LE(203).toString(),coinCreator:pk(b.subarray(211,243)),isMayhem:Boolean(b[243]),isCashback:Boolean(b[244]),virtualQuoteReserves:i128(b,245).toString()};
}
function token(v){
  if(!v)return {exists:false,amount:'0'};const b=Buffer.from(v.data[0],'base64');
  return {exists:true,program:v.owner,lamports:v.lamports,len:b.length,mint:b.length>=72?pk(b.subarray(0,32)):null,owner:b.length>=72?pk(b.subarray(32,64)):null,amount:b.length>=72?b.readBigUInt64LE(64).toString():'0'};
}
function mintProgram(owner){if(owner===TOKEN_PROGRAM_ID.toBase58())return TOKEN_PROGRAM_ID;if(owner===TOKEN_2022_PROGRAM_ID.toBase58())return TOKEN_2022_PROGRAM_ID;throw new Error(`unsupported mint owner ${owner}`);}
async function getMultiple(keys){
  const out=[];
  for(let i=0;i<keys.length;i+=100){
    const chunk=keys.slice(i,i+100);
    const r=await rpc('getMultipleAccounts',[chunk.map(x=>x.toBase58()),{encoding:'base64',commitment:'confirmed'}]);
    out.push(...(r?.value||[]));
    if(i+100<keys.length)await new Promise(x=>setTimeout(x,150));
  }
  return out;
}
async function account(k){return (await rpc('getAccountInfo',[k.toBase58(),{encoding:'base64',commitment:'confirmed'}]))?.value;}
async function balance(k){return BigInt((await rpc('getBalance',[k.toBase58(),{commitment:'confirmed'}]))?.value||0);}
function initIx(p,poolKey,creator,quoteProgram,vaultAuth,vault){return new TransactionInstruction({programId:PROGRAM,data:INIT_DISC,keys:[
  {pubkey:poolKey,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:creator,isSigner:true,isWritable:true},
  {pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},
  {pubkey:vaultAuth,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:quoteProgram,isSigner:false,isWritable:false},{pubkey:SYSTEM,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:EVENT_AUTH,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}
]});}
async function simulateInit(p,poolKey,creator,quoteProgram,vaultAuth,vault,watch){
  let feePayer=FALLBACK_FEE_PAYER;
  let feeBal=await balance(feePayer);
  if(feeBal<20_000_000n){feePayer=creator;feeBal=await balance(feePayer);}
  const creatorBal=await balance(creator);
  const ixs=[];
  if(creatorBal<5_000_000n&&feePayer.toBase58()!==creator.toBase58()&&feeBal>30_000_000n){
    // Simulation-only funding avoids misclassifying an otherwise eligible pool because its creator wallet is currently empty.
    ixs.push(SystemProgram.transfer({fromPubkey:feePayer,toPubkey:creator,lamports:10_000_000}));
  }
  ixs.push(initIx(p,poolKey,creator,quoteProgram,vaultAuth,vault));
  const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;
  const tx=new Transaction({feePayer,recentBlockhash:bh});tx.add(...ixs);
  const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
  const r=await rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'processed',accounts:{encoding:'base64',addresses:watch.map(x=>x.toBase58())}}]);
  return {r,feePayer:feePayer.toBase58(),creatorBalance:creatorBal.toString(),simFunding:ixs.length>1};
}
function summarize(r){const v=r?.value||{},logs=v.logs||[],txt=logs.join('\n');return {err:v.err??null,units:v.unitsConsumed??null,sawInit:txt.includes('Instruction: InitBoost'),invalidAdmin:txt.includes('InvalidAdmin'),anchorErrors:logs.filter(x=>x.includes('AnchorError')),programErrors:logs.filter(x=>x.includes('failed:')||x.includes('Error')),logs};}
async function main(){
  await chooseRpc();
  const indexBytes=Buffer.alloc(2);indexBytes.writeUInt16LE(1);
  const filters=[{dataSize:300},{memcmp:{offset:0,bytes:bs58.encode(POOL_DISC)}},{memcmp:{offset:9,bytes:bs58.encode(indexBytes)}},{memcmp:{offset:75,bytes:bs58.encode(WSOL.toBuffer())}}];
  const rows=await rpc('getProgramAccounts',[PROGRAM.toBase58(),{encoding:'base64',commitment:'confirmed',filters}]);
  console.log('DIRECT_WSOL_INDEX1_COUNT',rows?.length||0);
  const pools=(rows||[]).map(x=>decodePoolAccount(x.pubkey,x.account)).filter(Boolean).filter(p=>p.index===1&&p.quoteMint===WSOL.toBase58()&&BigInt(p.virtualQuoteReserves)===0n);
  console.log('DIRECT_WSOL_ZERO_VIRTUAL_COUNT',pools.length);
  if(!pools.length){console.log('FINAL NO_INDEX1_WSOL_ZERO_VIRTUAL_POOLS');return;}

  const quoteAccounts=await getMultiple(pools.map(p=>new PublicKey(p.poolQuote)));
  const ranked=pools.map((p,i)=>({...p,quoteToken:token(quoteAccounts[i]),quoteAmount:BigInt(token(quoteAccounts[i]).amount)})).filter(x=>x.quoteToken.exists).sort((a,b)=>a.quoteAmount===b.quoteAmount?0:(a.quoteAmount>b.quoteAmount?-1:1));
  console.log('TOP_RAW_QUOTES',JSON.stringify(ranked.slice(0,25).map(x=>({pool:x.pubkey,index:x.index,creator:x.creator,lpMint:x.lpMint,quote:x.quoteAmount.toString(),virtual:x.virtualQuoteReserves})),null,2));

  let tested=0;
  const outcomes=[];
  for(const p of ranked.slice(0,30)){
    if(p.quoteAmount<10_000_000n)break; // 0.01 SOL minimum only to avoid meaningless dust pools.
    const poolKey=new PublicKey(p.pubkey),creator=new PublicKey(p.creator),lpMint=new PublicKey(p.lpMint),quoteMint=new PublicKey(p.quoteMint);
    let mintInfos;try{mintInfos=await getMultiple([lpMint,quoteMint]);}catch(e){console.log('MINT_FETCH_ERROR',p.pubkey,String(e));continue;}
    if(!mintInfos[0]||!mintInfos[1])continue;
    let lpProgram,quoteProgram;try{lpProgram=mintProgram(mintInfos[0].owner);quoteProgram=mintProgram(mintInfos[1].owner);}catch(e){console.log('MINT_PROGRAM_ERROR',p.pubkey,String(e));continue;}
    const creatorLp=getAssociatedTokenAddressSync(lpMint,creator,true,lpProgram,ASSOCIATED_TOKEN_PROGRAM_ID);
    let creatorLpTok;try{creatorLpTok=token(await account(creatorLp));}catch{creatorLpTok={exists:false,amount:'0'};}
    const [vaultAuth]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),poolKey.toBuffer()],PROGRAM);
    const vault=getAssociatedTokenAddressSync(quoteMint,vaultAuth,true,quoteProgram,ASSOCIATED_TOKEN_PROGRAM_ID);
    let preVault;try{preVault=token(await account(vault));}catch{preVault={exists:false,amount:'0'};}
    tested++;
    let sim;try{sim=await simulateInit(p,poolKey,creator,quoteProgram,vaultAuth,vault,[poolKey,new PublicKey(p.poolQuote),vault]);}
    catch(e){console.log('SIM_RPC_ERROR',p.pubkey,String(e));continue;}
    const s=summarize(sim.r),post=sim.r?.value?.accounts||[],postPool=post[0]?decodePoolAccount(p.pubkey,post[0]):null,postQuote=token(post[1]),postVault=token(post[2]);
    const out={pool:p.pubkey,index:p.index,creator:p.creator,lpMint:p.lpMint,creatorLp:creatorLp.toBase58(),creatorLpAmount:creatorLpTok.amount,preQuote:p.quoteAmount.toString(),preVault:preVault.amount,simulation:s,postVirtual:postPool?.virtualQuoteReserves??null,postQuote:postQuote.amount,postVault:postVault.amount,quoteDelta:(BigInt(postQuote.amount)-p.quoteAmount).toString(),vaultDelta:(BigInt(postVault.amount)-BigInt(preVault.amount)).toString(),feePayer:sim.feePayer,creatorBalance:sim.creatorBalance,simulationFunding:sim.simFunding,simulationOnly:true,broadcast:false};
    outcomes.push(out);console.log('DIRECT_POOL_RESULT',JSON.stringify(out,null,2));
    if(s.err===null&&postPool&&BigInt(postPool.virtualQuoteReserves)!==0n){console.log('DECISIVE_DIRECT_POOL_BOOST_ACCEPTED',JSON.stringify(out,null,2));return;}
    if(tested>=20)break;
  }
  console.log('FINAL NO_DIRECT_POOL_FULL_INIT_ACCEPTED',JSON.stringify({tested,eligible:pools.length,topOutcomes:outcomes.slice(0,10).map(x=>({pool:x.pool,preQuote:x.preQuote,err:x.simulation.err,anchorErrors:x.simulation.anchorErrors,postVirtual:x.postVirtual}))},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
