import {PublicKey,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';

const RPC='https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const CORRECT=new PublicKey('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r');
const WRONG=new PublicKey('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ');
const POOL=new PublicKey('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
const INIT=Buffer.from('8ce9215e845ac28f','hex');
const BOOST=Buffer.from('694406af000723a2','hex');
const u64=x=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(x));return b};
const pk=b=>new PublicKey(b).toBase58();
function i128(b,o){const lo=b.readBigUInt64LE(o),hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo;}
async function rpc(method,params){for(let a=0;a<12;a++){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,450+a*350));continue;}const j=await r.json();if(j.error)throw new Error(`${method}: ${JSON.stringify(j.error)}`);return j.result;}throw new Error(`${method}: retries exhausted`)}
async function info(k){return (await rpc('getAccountInfo',[k.toBase58(),{encoding:'base64',commitment:'confirmed'}])).value}
async function multi(ks){return (await rpc('getMultipleAccounts',[ks.map(k=>k.toBase58()),{encoding:'base64',commitment:'confirmed'}])).value}
function pool(v){if(!v)return null;const b=Buffer.from(v.data[0],'base64');return {creator:pk(b.subarray(11,43)),baseMint:pk(b.subarray(43,75)),quoteMint:pk(b.subarray(75,107)),poolBase:pk(b.subarray(139,171)),poolQuote:pk(b.subarray(171,203)),virtual:i128(b,245).toString()}}
function tok(v){if(!v)return null;const b=Buffer.from(v.data[0],'base64');return {exists:true,amount:b.length>=72?b.readBigUInt64LE(64).toString():'0',ownerProgram:v.owner}}
function mintProgram(owner){if(owner===TOKEN_PROGRAM_ID.toBase58())return TOKEN_PROGRAM_ID;if(owner===TOKEN_2022_PROGRAM_ID.toBase58())return TOKEN_2022_PROGRAM_ID;throw new Error('unsupported '+owner)}
function initIx(p,creator,qProg,va,vault){return new TransactionInstruction({programId:PROGRAM,data:INIT,keys:[
 {pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:creator,isSigner:true,isWritable:true},
 {pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},
 {pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},
 {pubkey:va,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:qProg,isSigner:false,isWritable:false},
 {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
 {pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]})}
function boostIx(p,authority,bProg,qProg,va,vault,quoteIn){return new TransactionInstruction({programId:PROGRAM,data:Buffer.concat([BOOST,u64(quoteIn),u64(0)]),keys:[
 {pubkey:POOL,isSigner:false,isWritable:false},{pubkey:authority,isSigner:true,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},
 {pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:true},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},
 {pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:true},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},
 {pubkey:va,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:bProg,isSigner:false,isWritable:false},{pubkey:qProg,isSigner:false,isWritable:false},
 {pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]})}
async function simulate(ixs,watch,bh){const tx=new Transaction({feePayer:WRONG,recentBlockhash:bh});tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:700000}),...ixs);const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');return rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'processed',accounts:{encoding:'base64',addresses:watch.map(k=>k.toBase58())}}])}
function summarize(r,names){const v=r?.value||{},logs=v.logs||[],acs=v.accounts||[];return {slot:r?.context?.slot??null,err:v.err??null,units:v.unitsConsumed??null,accounts:Object.fromEntries(names.map((n,i)=>[n,n==='pool'?pool(acs[i]??null):tok(acs[i]??null)])),anchor:logs.filter(x=>x.includes('AnchorError')||x.includes('Error Code:')),instructions:logs.filter(x=>x.includes('Instruction:')),failed:logs.filter(x=>x.includes('failed:')),logs}}

async function main(){
 const p=pool(await info(POOL)); if(!p)throw new Error('pool missing'); if(BigInt(p.virtual)!==0n)throw new Error('pool already boosted live'); if(p.quoteMint!==WSOL.toBase58())throw new Error('not WSOL');
 const [bm,qm]=await multi([new PublicKey(p.baseMint),new PublicKey(p.quoteMint)]);const bProg=mintProgram(bm.owner),qProg=mintProgram(qm.owner);
 const creator=new PublicKey(p.creator);const [va]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),POOL.toBuffer()],PROGRAM);const vault=getAssociatedTokenAddressSync(WSOL,va,true,qProg,ASSOCIATED_TOKEN_PROGRAM_ID);
 const common=[createAssociatedTokenAccountIdempotentInstruction(WRONG,vault,va,WSOL,qProg,ASSOCIATED_TOKEN_PROGRAM_ID),initIx(p,creator,qProg,va,vault)];
 const watch=[POOL,new PublicKey(p.poolBase),new PublicKey(p.poolQuote),vault];const names=['pool','poolBase','poolQuote','vault'];const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;
 const initOnly=await simulate(common,watch,bh);const ini=summarize(initOnly,names);console.log('INIT_ONLY',JSON.stringify(ini,null,2));if(ini.err!==null)throw new Error('init failed');const available=BigInt(ini.accounts.vault?.amount??0);if(available<=0n)throw new Error('init vault empty');let amount=available/100n;if(amount>1_000_000_000n)amount=1_000_000_000n;if(amount<1_000_000n)amount=available/2n;
 const [cr,wr]=await Promise.all([simulate([...common,boostIx(p,CORRECT,bProg,qProg,va,vault,amount)],watch,bh),simulate([...common,boostIx(p,WRONG,bProg,qProg,va,vault,amount)],watch,bh)]);
 const c=summarize(cr,names),w=summarize(wr,names);console.log('CORRECT_AUTH',JSON.stringify(c,null,2));console.log('WRONG_AUTH',JSON.stringify(w,null,2));
 console.log('DECISIVE',JSON.stringify({amount:amount.toString(),correctErr:c.err,wrongErr:w.err,correctSlot:c.slot,wrongSlot:w.slot,correctVault:c.accounts.vault?.amount??null,wrongVault:w.accounts.vault?.amount??null,correctVirtual:c.accounts.pool?.virtual??null,wrongVirtual:w.accounts.pool?.virtual??null,wrongAnchor:w.anchor,wrongInstructions:w.instructions,wrongFailed:w.failed,correctAnchor:c.anchor,correctInstructions:c.instructions,correctFailed:c.failed},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
