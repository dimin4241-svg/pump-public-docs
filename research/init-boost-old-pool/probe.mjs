import fs from "node:fs";
import { BorshCoder } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";

const RPC = process.env.DEVNET_RPC || "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const GLOBAL_CONFIG = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const PAYER = new PublicKey("CbNuzY28nDxSX9t29bJWidZeFfzLduZ4rwSmoMh54rkR");
const TARGET_QUOTE = 84_990_000_000n;

function emit(status, extra={}) { console.log(JSON.stringify({status,...extra}, null, 2)); }
function tokenAmount(data) { return data?.length >= 72 ? data.readBigUInt64LE(64) : null; }
function asBigInt(v) { return BigInt(v?.toString?.() ?? v); }
function simData(entry) { if (!entry?.data) return null; return Buffer.from(Array.isArray(entry.data) ? entry.data[0] : entry.data, "base64"); }
async function getMany(c, keys) { const out=[]; for(let i=0;i<keys.length;i+=100) out.push(...await c.getMultipleAccountsInfo(keys.slice(i,i+100),"confirmed")); return out; }
async function rawSim(serialized, addresses) {
  const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"simulateTransaction",params:[serialized.toString("base64"),{encoding:"base64",commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:true,accounts:{encoding:"base64",addresses:addresses.map(String)}}]})});
  const j=await r.json(); if(j.error) throw new Error(JSON.stringify(j.error)); return j.result.value;
}

const c=new Connection(RPC,"confirmed");
const genesis=await c.getGenesisHash();
if(genesis!==DEVNET_GENESIS){emit("SAFETY_ABORT_NOT_DEVNET",{genesis});process.exit(2)}
console.log(`SAFETY_GATE devnet genesis verified: ${genesis}`);

const idl=JSON.parse(fs.readFileSync(new URL("../../idl/pump_amm.json", import.meta.url),"utf8"));
const coder=new BorshCoder(idl);
const poolDesc=idl.accounts.find(x=>x.name==="Pool");
const initDesc=idl.instructions.find(x=>x.name==="init_boost");
const globalInfo=await c.getAccountInfo(GLOBAL_CONFIG,"confirmed");
const global=coder.accounts.decode("GlobalConfig",globalInfo.data);
const admin=new PublicKey(global.admin), boostAuthority=new PublicKey(global.boostAuthority??global.boost_authority);
if(PAYER.equals(admin)||PAYER.equals(boostAuthority)) throw new Error("payer unexpectedly privileged");
const payerInfo=await c.getAccountInfo(PAYER,"confirmed");
if(!payerInfo||!payerInfo.owner.equals(SystemProgram.programId)||payerInfo.lamports<5_000_000) throw new Error("fallback payer unavailable");

// Find canonical, index-0, WSOL, zero-virtual pools. These are candidates from the old regime.
const rows=await c.getProgramAccounts(PUMP_AMM,{commitment:"confirmed",filters:[
  {memcmp:{offset:0,bytes:bs58.encode(Buffer.from(poolDesc.discriminator))}},
  {memcmp:{offset:9,bytes:bs58.encode(Buffer.alloc(2))}},
  {memcmp:{offset:75,bytes:NATIVE_MINT.toBase58()}},
  {memcmp:{offset:245,bytes:bs58.encode(Buffer.alloc(16))}},
],dataSlice:{offset:0,length:261}});

const candidates=[];
for(const row of rows){
  try{
    const pool=coder.accounts.decode("Pool",row.account.data);
    const baseMint=new PublicKey(pool.baseMint??pool.base_mint);
    const creator=new PublicKey(pool.creator);
    const [canonicalCreator]=PublicKey.findProgramAddressSync([Buffer.from("pool-authority"),baseMint.toBuffer()],PUMP);
    if(!creator.equals(canonicalCreator)) continue;
    candidates.push({pubkey:row.pubkey,pool,baseMint,creator,poolQuote:new PublicKey(pool.poolQuoteTokenAccount??pool.pool_quote_token_account),poolBase:new PublicKey(pool.poolBaseTokenAccount??pool.pool_base_token_account)});
  }catch{}
}
console.log(`OLD_POOL_DISCOVERY zero_virtual=${rows.length} canonical=${candidates.length}`);

const sample=candidates.slice(0,1200);
const quoteInfos=await getMany(c,sample.map(x=>x.poolQuote));
const ranked=[];
for(let i=0;i<sample.length;i++){
  const q=tokenAmount(quoteInfos[i]?.data); if(q===null||q<60_000_000_000n) continue;
  const distance=q>TARGET_QUOTE?q-TARGET_QUOTE:TARGET_QUOTE-q;
  ranked.push({...sample[i],quoteBefore:q,distance});
}
ranked.sort((a,b)=>a.distance===b.distance?0:a.distance<b.distance?-1:1);
console.log("TOP_OLD_POOLS", ranked.slice(0,10).map(x=>({pool:x.pubkey.toBase58(),quote:x.quoteBefore.toString(),distance:x.distance.toString()})));
if(!ranked.length){emit("INCONCLUSIVE_NO_HIGH_RESERVE_OLD_POOL");process.exit(3)}

let target=null;
for(const cand of ranked.slice(0,40)){
  const [boostVaultAuthority]=PublicKey.findProgramAddressSync([Buffer.from("boost_vault"),cand.pubkey.toBuffer()],PUMP_AMM);
  const boostVault=getAssociatedTokenAddressSync(NATIVE_MINT,boostVaultAuthority,true,TOKEN_PROGRAM_ID);
  const bi=await c.getAccountInfo(boostVault,"confirmed");
  const amt=tokenAmount(bi?.data);
  if(!bi||amt===0n){target={...cand,boostVaultAuthority,boostVault,boostBefore:amt};break;}
}
if(!target){emit("INCONCLUSIVE_ALL_HIGH_RESERVE_OLD_POOLS_HAVE_FUNDED_BOOST");process.exit(4)}

const [eventAuthority]=PublicKey.findProgramAddressSync([Buffer.from("__event_authority")],PUMP_AMM);
const ix=new TransactionInstruction({programId:PUMP_AMM,keys:[
  {pubkey:target.pubkey,isSigner:false,isWritable:true},
  {pubkey:GLOBAL_CONFIG,isSigner:false,isWritable:false},
  {pubkey:PAYER,isSigner:true,isWritable:true},
  {pubkey:target.baseMint,isSigner:false,isWritable:false},
  {pubkey:NATIVE_MINT,isSigner:false,isWritable:false},
  {pubkey:target.poolBase,isSigner:false,isWritable:false},
  {pubkey:target.poolQuote,isSigner:false,isWritable:true},
  {pubkey:target.boostVaultAuthority,isSigner:false,isWritable:false},
  {pubkey:target.boostVault,isSigner:false,isWritable:true},
  {pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
  {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
  {pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
  {pubkey:eventAuthority,isSigner:false,isWritable:false},
  {pubkey:PUMP_AMM,isSigner:false,isWritable:false},
],data:Buffer.from(initDesc.discriminator)});
const tx=new Transaction().add(ix); tx.feePayer=PAYER; tx.recentBlockhash=(await c.getLatestBlockhash("confirmed")).blockhash;
const serialized=tx.serialize({requireAllSignatures:false,verifySignatures:false});
console.log(JSON.stringify({test:"permissionless init_boost on high-reserve zero-virtual canonical pool",pool:target.pubkey.toBase58(),payer:PAYER.toBase58(),payerIsAdmin:PAYER.equals(admin),payerIsBoostAuthority:PAYER.equals(boostAuthority),poolCreator:target.creator.toBase58(),quoteBefore:target.quoteBefore.toString(),virtualBefore:asBigInt(target.pool.virtualQuoteReserves??target.pool.virtual_quote_reserves).toString(),boostVault:target.boostVault.toBase58(),boostBefore:target.boostBefore?.toString()??null},null,2));

const result=await rawSim(serialized,[target.pubkey,target.poolQuote,target.boostVault]);
console.log("--- OLD POOL INIT_BOOST LOGS ---"); for(const l of result.logs||[]) console.log(l); console.log("--- END LOGS ---");
const postPoolData=simData(result.accounts?.[0]); const postQuoteData=simData(result.accounts?.[1]); const postBoostData=simData(result.accounts?.[2]);
let virtualAfter=null; if(postPoolData){try{const p=coder.accounts.decode("Pool",postPoolData);virtualAfter=asBigInt(p.virtualQuoteReserves??p.virtual_quote_reserves)}catch{}}
const quoteAfter=tokenAmount(postQuoteData), boostAfter=tokenAmount(postBoostData);
const summary={simulationError:result.err,pool:target.pubkey.toBase58(),quoteBefore:target.quoteBefore.toString(),quoteAfter:quoteAfter?.toString()??null,quoteDelta:quoteAfter!==null?(quoteAfter-target.quoteBefore).toString():null,virtualBefore:"0",virtualAfter:virtualAfter?.toString()??null,boostBefore:target.boostBefore?.toString()??null,boostAfter:boostAfter?.toString()??null,boostDelta:boostAfter!==null?(boostAfter-(target.boostBefore??0n)).toString():null};
if(result.err===null && virtualAfter!==null && virtualAfter>0n){emit("CONFIRMED_PERMISSIONLESS_MEANINGFUL_INIT_BOOST",summary);process.exit(0)}
if(result.err===null){emit("PERMISSIONLESS_INIT_NO_MEANINGFUL_TRANSITION",summary);process.exit(0)}
emit("REJECTED_OLD_POOL_INIT_BOOST",summary);process.exit(12);
