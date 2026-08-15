import {PublicKey,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';

const RPC='https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const POOL=new PublicKey('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
const WRONG=new PublicKey('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ');
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
const INIT=Buffer.from('8ce9215e845ac28f','hex');
const pk=b=>new PublicKey(b).toBase58();
function i128(b,o){const lo=b.readBigUInt64LE(o),hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo;}
async function rpc(method,params){for(let a=0;a<12;a++){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,400+a*300));continue;}const j=await r.json();if(j.error)throw new Error(`${method}: ${JSON.stringify(j.error)}`);return j.result;}throw new Error(`${method}: retries exhausted`)}
async function info(k){return (await rpc('getAccountInfo',[k.toBase58(),{encoding:'base64',commitment:'confirmed'}])).value}
async function multi(ks){return (await rpc('getMultipleAccounts',[ks.map(k=>k.toBase58()),{encoding:'base64',commitment:'confirmed'}])).value}
function pool(v){if(!v)return null;const b=Buffer.from(v.data[0],'base64');return {creator:pk(b.subarray(11,43)),baseMint:pk(b.subarray(43,75)),quoteMint:pk(b.subarray(75,107)),poolBase:pk(b.subarray(139,171)),poolQuote:pk(b.subarray(171,203)),lpSupply:b.readBigUInt64LE(203).toString(),virtual:i128(b,245).toString()}}
function tok(v){if(!v)return null;const b=Buffer.from(v.data[0],'base64');return {amount:b.length>=72?b.readBigUInt64LE(64).toString():'0',ownerProgram:v.owner}}
function mintProgram(owner){if(owner===TOKEN_PROGRAM_ID.toBase58())return TOKEN_PROGRAM_ID;if(owner===TOKEN_2022_PROGRAM_ID.toBase58())return TOKEN_2022_PROGRAM_ID;throw new Error('unsupported '+owner)}
function initIx(p,creator,qProg,va,vault){return new TransactionInstruction({programId:PROGRAM,data:INIT,keys:[
 {pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:creator,isSigner:true,isWritable:true},
 {pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},
 {pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},
 {pubkey:va,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:qProg,isSigner:false,isWritable:false},
 {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
 {pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]})}
async function simulate(ixs,watch,bh){const tx=new Transaction({feePayer:WRONG,recentBlockhash:bh});tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:500000}),...ixs);const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');return rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'processed',accounts:{encoding:'base64',addresses:watch.map(k=>k.toBase58())}}])}
function summary(r,names){const v=r?.value||{},logs=v.logs||[],acs=v.accounts||[];return {slot:r?.context?.slot??null,err:v.err??null,units:v.unitsConsumed??null,accounts:Object.fromEntries(names.map((n,i)=>[n,n==='pool'?pool(acs[i]??null):tok(acs[i]??null)])),anchor:logs.filter(x=>x.includes('AnchorError')||x.includes('Error Code:')),instructions:logs.filter(x=>x.includes('Instruction:')),failed:logs.filter(x=>x.includes('failed:')),logs}}
async function main(){
 const p=pool(await info(POOL));if(!p)throw new Error('pool missing');if(BigInt(p.virtual)!==0n)throw new Error('pool no longer clean virtual=0');if(p.quoteMint!==WSOL.toBase58())throw new Error('not WSOL');
 const qm=await info(new PublicKey(p.quoteMint));const qProg=mintProgram(qm.owner);const trueCreator=new PublicKey(p.creator);
 const [va]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),POOL.toBuffer()],PROGRAM);const vault=getAssociatedTokenAddressSync(WSOL,va,true,qProg,ASSOCIATED_TOKEN_PROGRAM_ID);
 const createVault=createAssociatedTokenAccountIdempotentInstruction(WRONG,vault,va,WSOL,qProg,ASSOCIATED_TOKEN_PROGRAM_ID);
 const watch=[POOL,new PublicKey(p.poolQuote),vault];const names=['pool','poolQuote','vault'];const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;
 const [tr,wr]=await Promise.all([simulate([createVault,initIx(p,trueCreator,qProg,va,vault)],watch,bh),simulate([createVault,initIx(p,WRONG,qProg,va,vault)],watch,bh)]);
 const t=summary(tr,names),w=summary(wr,names);console.log('PRE',JSON.stringify(p,null,2));console.log('TRUE_CREATOR',JSON.stringify(t,null,2));console.log('WRONG_CREATOR',JSON.stringify(w,null,2));
 console.log('DECISIVE',JSON.stringify({trueCreator:trueCreator.toBase58(),wrongCreator:WRONG.toBase58(),trueErr:t.err,wrongErr:w.err,trueSlot:t.slot,wrongSlot:w.slot,trueVirtual:t.accounts.pool?.virtual??null,wrongVirtual:w.accounts.pool?.virtual??null,trueQuote:t.accounts.poolQuote?.amount??null,wrongQuote:w.accounts.poolQuote?.amount??null,trueVault:t.accounts.vault?.amount??null,wrongVault:w.accounts.vault?.amount??null,wrongAnchor:w.anchor,wrongInstructions:w.instructions,wrongFailed:w.failed},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
