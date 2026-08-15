import fs from 'node:fs';
import {BorshEventCoder} from '@coral-xyz/anchor';
import {PublicKey,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync,createBurnInstruction} from '@solana/spl-token';

const RPC='https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const AUTH=new PublicKey('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r');
const PAYER=new PublicKey('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ');
const POOL=new PublicKey('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
const BURN_ACCOUNT=new PublicKey('9V7q1PWgKyDwefFGrr3zKZnyH1A9uoJDdkHyoFoEH3tp');
const BURN_OWNER=new PublicKey('3boQGR98y97YxAWsLcNZDL14GEFpd8D1pVgnZaFZiyYw');
const HOLDER_BAL=64_712_599_462_288n;
const INIT=Buffer.from('8ce9215e845ac28f','hex');
const BOOST=Buffer.from('694406af000723a2','hex');
const coder=new BorshEventCoder(JSON.parse(fs.readFileSync('idl/pump_amm.json','utf8')));
const u64=x=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(x));return b};
const pk=b=>new PublicKey(b).toBase58();
function i128(b,o){const lo=b.readBigUInt64LE(o),hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo;}
async function rpc(method,params){for(let a=0;a<14;a++){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,350+a*250));continue;}const j=await r.json();if(j.error)throw new Error(`${method}: ${JSON.stringify(j.error)}`);return j.result;}throw new Error(`${method}: retries exhausted`)}
async function info(k){return (await rpc('getAccountInfo',[k.toBase58(),{encoding:'base64',commitment:'confirmed'}])).value}
async function multi(ks){return (await rpc('getMultipleAccounts',[ks.map(k=>k.toBase58()),{encoding:'base64',commitment:'confirmed'}])).value}
function pool(v){const b=Buffer.from(v.data[0],'base64');return {creator:pk(b.subarray(11,43)),baseMint:pk(b.subarray(43,75)),quoteMint:pk(b.subarray(75,107)),poolBase:pk(b.subarray(139,171)),poolQuote:pk(b.subarray(171,203)),virtual:i128(b,245).toString()}}
function mintProgram(owner){if(owner===TOKEN_PROGRAM_ID.toBase58())return TOKEN_PROGRAM_ID;if(owner===TOKEN_2022_PROGRAM_ID.toBase58())return TOKEN_2022_PROGRAM_ID;throw new Error('unsupported '+owner)}
function initIx(p,creator,qProg,va,vault){return new TransactionInstruction({programId:PROGRAM,data:INIT,keys:[{pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:creator,isSigner:true,isWritable:true},{pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},{pubkey:va,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:qProg,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]})}
function boostIx(p,bProg,qProg,va,vault,quoteIn){return new TransactionInstruction({programId:PROGRAM,data:Buffer.concat([BOOST,u64(quoteIn),u64(0)]),keys:[{pubkey:POOL,isSigner:false,isWritable:false},{pubkey:AUTH,isSigner:true,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:true},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:true},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},{pubkey:va,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:bProg,isSigner:false,isWritable:false},{pubkey:qProg,isSigner:false,isWritable:false},{pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]})}
async function simulate(ixs,bh){const tx=new Transaction({feePayer:PAYER,recentBlockhash:bh});tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:800000}),...ixs);const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');return rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'processed'}])}
function bnToBig(v){if(v===null||v===undefined)return null;if(typeof v==='bigint')return v;if(typeof v.toString==='function')return BigInt(v.toString());return BigInt(v)}
function buyEvent(logs){for(const l of logs||[]){if(!l.startsWith('Program data: '))continue;try{const e=coder.decode(l.slice(14));if(e?.name==='BuyEvent')return {canBoost:e.data.can_boost??e.data.canBoost,baseSupply:bnToBig(e.data.base_supply??e.data.baseSupply),baseOut:bnToBig(e.data.base_amount_out??e.data.baseAmountOut),virtual:bnToBig(e.data.virtual_quote_reserves??e.data.virtualQuoteReserves)};}catch{}}return null}
async function main(){
 const p=pool(await info(POOL));if(BigInt(p.virtual)!==0n)throw new Error('live pool already boosted');const [bm,qm,ba]=await multi([new PublicKey(p.baseMint),new PublicKey(p.quoteMint),BURN_ACCOUNT]);const bProg=mintProgram(bm.owner),qProg=mintProgram(qm.owner);if(bProg.toBase58()!==TOKEN_PROGRAM_ID.toBase58())throw new Error('expected classic SPL base mint');const bd=Buffer.from(ba.data[0],'base64');const onchainBal=bd.readBigUInt64LE(64);console.log('HOLDER',JSON.stringify({account:BURN_ACCOUNT.toBase58(),owner:BURN_OWNER.toBase58(),expected:HOLDER_BAL.toString(),onchain:onchainBal.toString()},null,2));
 const creator=new PublicKey(p.creator);const [va]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),POOL.toBuffer()],PROGRAM);const vault=getAssociatedTokenAddressSync(WSOL,va,true,qProg,ASSOCIATED_TOKEN_PROGRAM_ID);const common=[createAssociatedTokenAccountIdempotentInstruction(PAYER,vault,va,WSOL,qProg,ASSOCIATED_TOKEN_PROGRAM_ID),initIx(p,creator,qProg,va,vault)];const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;
 const init=await simulate(common,bh);if(init.value.err)throw new Error('init failed '+JSON.stringify(init.value.err));let available=82_815_481_362n;const boostAmount=available/100n;
 const samples=[0n,1n,1_000_000n,onchainBal/1000n,onchainBal/100n,onchainBal/10n,onchainBal/4n,onchainBal/2n,(onchainBal*3n)/4n,onchainBal];
 const seen=new Set();for(const burn of samples){if(seen.has(burn.toString()))continue;seen.add(burn.toString());const ixs=[...common];if(burn>0n)ixs.push(createBurnInstruction(BURN_ACCOUNT,new PublicKey(p.baseMint),BURN_OWNER,burn,[],TOKEN_PROGRAM_ID));ixs.push(boostIx(p,bProg,qProg,va,vault,boostAmount));const r=await simulate(ixs,bh);const ev=buyEvent(r.value.logs);console.log('CASE',JSON.stringify({burn:burn.toString(),burnPctHolder:Number(burn*1000000n/onchainBal)/10000,err:r.value.err,event:ev?{canBoost:ev.canBoost,baseSupply:ev.baseSupply?.toString(),baseOut:ev.baseOut?.toString(),virtual:ev.virtual?.toString()}:null,anchor:(r.value.logs||[]).filter(x=>x.includes('AnchorError')||x.includes('Error Code:'))},null,2));}
}
main().catch(e=>{console.error(e);process.exit(1)});
