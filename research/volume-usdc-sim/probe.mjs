import fs from "node:fs";
import { BorshCoder } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const RPC=process.env.DEVNET_RPC||"https://api.devnet.solana.com";
const DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PUMP=new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const ASSOCIATED_TOKEN_PROGRAM=new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM=new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const HISTORICAL_BUY="3dWgjUAnZSX7WVKw2E3qjn1huvivQbRoAek4s6VNwwoz3pAktXJjQHycer2npH2MkRKoWYj774T581ZyTmy8oAhJ";
const EXPECTED_USDC="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const field=(o,a,b)=>o?.[a]??o?.[b];
const asBig=(v)=>BigInt(v?.toString?.()??v??0);
const u64=(v)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b};
const jsonSafe=(v)=>{
  if(typeof v==="bigint")return v.toString();
  if(v?.toBase58)return v.toBase58();
  if(v?.toString&&v.constructor?.name==="BN")return v.toString();
  if(Array.isArray(v))return v.map(jsonSafe);
  if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,jsonSafe(x)]));
  return v;
};
const simData=(e)=>!e?.data?null:Buffer.from(Array.isArray(e.data)?e.data[0]:e.data,"base64");
function ata(owner,mint,tokenProgram=TOKEN_PROGRAM){return PublicKey.findProgramAddressSync([owner.toBuffer(),tokenProgram.toBuffer(),mint.toBuffer()],ASSOCIATED_TOKEN_PROGRAM)[0]}
function keysOf(tx){const m=tx.transaction.message;if(m.staticAccountKeys)return[...m.staticAccountKeys.map(String),...(tx.meta?.loadedAddresses?.writable??[]).map(String),...(tx.meta?.loadedAddresses?.readonly??[]).map(String)];return(m.accountKeys??[]).map(x=>String(x.pubkey??x))}
function ixsOf(tx){return tx.transaction.message.compiledInstructions??tx.transaction.message.instructions??[]}
function dataOf(ix){if(ix.data instanceof Uint8Array||Buffer.isBuffer(ix.data))return Buffer.from(ix.data);if(typeof ix.data==="string"){try{return Buffer.from((await import("bs58")).default.decode(ix.data))}catch{return Buffer.from(ix.data,"base64")}}return Buffer.alloc(0)}

// Synchronous bs58 helper without dynamic-await in parser.
import bs58 from "bs58";
function ixData(ix){if(ix.data instanceof Uint8Array||Buffer.isBuffer(ix.data))return Buffer.from(ix.data);if(typeof ix.data==="string"){try{return Buffer.from(bs58.decode(ix.data))}catch{return Buffer.from(ix.data,"base64")}}return Buffer.alloc(0)}
function ixAccounts(ix){return Array.from(ix.accountKeyIndexes??ix.accounts??[])}

async function rawSim(serialized,addresses){const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"simulateTransaction",params:[serialized.toString("base64"),{encoding:"base64",commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:true,accounts:{encoding:"base64",addresses:addresses.map(String)}}]})});const j=await r.json();if(j.error)throw new Error(JSON.stringify(j.error));return j.result.value}

const c=new Connection(RPC,"confirmed");
const genesis=await c.getGenesisHash();if(genesis!==DEVNET_GENESIS)throw new Error(`SAFETY ${genesis}`);console.log(`SAFETY_GATE devnet genesis verified: ${genesis}`);
const idl=JSON.parse(fs.readFileSync(new URL("../../idl/pump.json",import.meta.url),"utf8"));
const coder=new BorshCoder(idl);const buy=idl.instructions.find(x=>x.name==="buy_v2");const disc=Buffer.from(buy.discriminator);
const old=await c.getTransaction(HISTORICAL_BUY,{commitment:"confirmed",maxSupportedTransactionVersion:0});if(!old)throw new Error("historical tx unavailable");
const keys=keysOf(old);let accounts=null;
for(const ci of ixsOf(old)){if(ci.programIdIndex===undefined||keys[ci.programIdIndex]!==PUMP.toBase58())continue;const d=ixData(ci);if(d.length>=8&&d.subarray(0,8).equals(disc)){accounts=ixAccounts(ci).map(i=>new PublicKey(keys[i]));break}}
if(!accounts||accounts.length!==27)throw new Error(`buy_v2 account set not recovered: ${accounts?.length}`);
const user=accounts[13],baseMint=accounts[1],quoteMint=accounts[2],bondingCurve=accounts[10],userBase=accounts[14],userQuote=accounts[15],userVolume=accounts[20];
if(quoteMint.toBase58()!==EXPECTED_USDC)throw new Error(`historical quote changed/unexpected ${quoteMint}`);
const [globalPda]=PublicKey.findProgramAddressSync([Buffer.from("global")],PUMP);accounts[0]=globalPda;
const [globalInfo,bcInfo,uvaInfo,userQuoteInfo,userBaseInfo]=await Promise.all([c.getAccountInfo(globalPda,"confirmed"),c.getAccountInfo(bondingCurve,"confirmed"),c.getAccountInfo(userVolume,"confirmed"),c.getAccountInfo(userQuote,"confirmed"),c.getAccountInfo(userBase,"confirmed")]);
if(!globalInfo||!bcInfo||!uvaInfo||!userQuoteInfo)throw new Error("required current state missing");
const global=coder.accounts.decode("Global",globalInfo.data);const bc=coder.accounts.decode("BondingCurve",bcInfo.data);const uvaBefore=coder.accounts.decode("UserVolumeAccumulator",uvaInfo.data);
if(Boolean(bc.complete))throw new Error("curve completed since discovery");if(new PublicKey(field(bc,"quoteMint","quote_mint")).toBase58()!==EXPECTED_USDC)throw new Error("curve no longer USDC");
// Refresh current protocol recipients; keep other historically canonical accounts.
const normal=[new PublicKey(global.fee_recipient),...(global.fee_recipients??[]).map(x=>new PublicKey(x))];const buybacks=(global.buyback_fee_recipients??[]).map(x=>new PublicKey(x));
accounts[6]=normal.find(x=>!x.equals(PublicKey.default))??accounts[6];accounts[7]=ata(accounts[6],quoteMint);accounts[8]=buybacks.find(x=>!x.equals(PublicKey.default))??accounts[8];accounts[9]=ata(accounts[8],quoteMint);
const amountBase=1_000_000n;const data=Buffer.concat([disc,u64(amountBase),u64(18_446_744_073_709_551_615n)]);
const writable=new Set(buy.accounts.filter(x=>x.writable).map(x=>x.name));const signers=new Set(buy.accounts.filter(x=>x.signer).map(x=>x.name));
const ix=new TransactionInstruction({programId:PUMP,data,keys:accounts.map((pubkey,i)=>({pubkey,isWritable:writable.has(buy.accounts[i].name),isSigner:signers.has(buy.accounts[i].name)}))});
const tx=new Transaction().add(ix);tx.feePayer=user;tx.recentBlockhash=(await c.getLatestBlockhash("confirmed")).blockhash;const serialized=tx.serialize({requireAllSignatures:false,verifySignatures:false});
console.log(JSON.stringify({test:"USDC buy_v2 volume delta",user:user.toBase58(),baseMint:baseMint.toBase58(),quoteMint:quoteMint.toBase58(),bondingCurve:bondingCurve.toBase58(),userQuoteBalanceBefore:userQuoteInfo.data.readBigUInt64LE(64).toString(),uvaBefore:jsonSafe(uvaBefore),amountBase:amountBase.toString()},null,2));
const res=await rawSim(serialized,[userVolume,userQuote,userBase]);console.log("--- USDC VOLUME SIM LOGS ---");for(const l of res.logs??[])console.log(l);console.log("--- END LOGS ---");
let uvaAfter=null;if(simData(res.accounts?.[0])){try{uvaAfter=coder.accounts.decode("UserVolumeAccumulator",simData(res.accounts[0]))}catch{}}
let trade=null;for(const l of res.logs??[]){if(!l.startsWith("Program data: "))continue;try{const ev=coder.events.decode(l.slice(14));if(ev?.name==="TradeEvent")trade=jsonSafe(ev.data)}catch{}}
const beforeVol=asBig(field(uvaBefore,"currentSolVolume","current_sol_volume"));const afterVol=uvaAfter?asBig(field(uvaAfter,"currentSolVolume","current_sol_volume")):null;
const out={simulationError:res.err,uvaBefore:jsonSafe(uvaBefore),uvaAfter:jsonSafe(uvaAfter),currentSolVolumeBefore:beforeVol.toString(),currentSolVolumeAfter:afterVol?.toString()??null,currentSolVolumeDelta:afterVol===null?null:(afterVol-beforeVol).toString(),tradeEvent:trade};
console.log(JSON.stringify({status:res.err===null?"USDC_VOLUME_SIM_SUCCESS":"USDC_VOLUME_SIM_REJECTED",...out},null,2));
if(res.err!==null)process.exit(12);
