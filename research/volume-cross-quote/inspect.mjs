import fs from "node:fs";
import { BorshCoder } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC=process.env.DEVNET_RPC||"https://api.devnet.solana.com";
const DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PUMP=new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const NATIVE="So11111111111111111111111111111111111111112";

const c=new Connection(RPC,"confirmed");
const genesis=await c.getGenesisHash();
if(genesis!==DEVNET_GENESIS) throw new Error(`SAFETY wrong genesis ${genesis}`);
console.log(`SAFETY_GATE devnet genesis verified: ${genesis}`);

const idl=JSON.parse(fs.readFileSync(new URL("../../idl/pump.json",import.meta.url),"utf8"));
const coder=new BorshCoder(idl);
for(const name of ["UserVolumeAccumulator","GlobalVolumeAccumulator","TradeEvent","ClaimTokenIncentivesEvent"]){
  const t=idl.types?.find(x=>x.name===name);
  console.log(`TYPE_${name}`,JSON.stringify(t??null,null,2));
}

function jsonSafe(v){
  if(typeof v==="bigint") return v.toString();
  if(v?.toBase58) return v.toBase58();
  if(Array.isArray(v)) return v.map(jsonSafe);
  if(v&&typeof v==="object") return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,jsonSafe(x)]));
  return v;
}

const sigs=await c.getSignaturesForAddress(PUMP,{limit:500},"confirmed");
const decoded=[];
for(const s of sigs){
  if(s.err) continue;
  let tx;
  try{tx=await c.getTransaction(s.signature,{commitment:"confirmed",maxSupportedTransactionVersion:0});}catch{continue;}
  if(!tx) continue;
  for(const line of tx.meta?.logMessages??[]){
    if(!line.startsWith("Program data: ")) continue;
    const payload=line.slice("Program data: ".length);
    try{
      const ev=coder.events.decode(payload);
      if(!ev) continue;
      if(ev.name!=="TradeEvent"&&ev.name!=="ClaimTokenIncentivesEvent") continue;
      decoded.push({signature:s.signature,slot:s.slot,blockTime:s.blockTime,name:ev.name,data:jsonSafe(ev.data)});
    }catch{}
  }
  if(decoded.filter(x=>x.name==="TradeEvent").length>=80) break;
}

console.log(`DECODED_EVENTS ${decoded.length}`);
const trades=decoded.filter(x=>x.name==="TradeEvent");
const fieldNames=[...new Set(trades.flatMap(x=>Object.keys(x.data??{})))];
console.log("TRADE_EVENT_FIELDS",fieldNames);
const quoteField=fieldNames.find(k=>/quote.*mint/i.test(k));
const volumeField=fieldNames.find(k=>/current.*(sol|quote).*volume/i.test(k));
const amountFields=fieldNames.filter(k=>/(sol|quote).*amount|amount.*(sol|quote)/i.test(k));
console.log(JSON.stringify({quoteField,volumeField,amountFields},null,2));

const nonNative=quoteField?trades.filter(x=>String(x.data?.[quoteField])!==NATIVE&&String(x.data?.[quoteField])!=="11111111111111111111111111111111"):[];
console.log("NON_NATIVE_TRADE_EVENTS",JSON.stringify(nonNative.slice(0,30),null,2));
console.log("NATIVE_TRADE_EVENTS",JSON.stringify(quoteField?trades.filter(x=>String(x.data?.[quoteField])===NATIVE||String(x.data?.[quoteField])==="11111111111111111111111111111111").slice(0,10):trades.slice(0,10),null,2));

if(!quoteField){
  console.log(JSON.stringify({status:"INCONCLUSIVE_EVENT_HAS_NO_QUOTE_MINT",tradeFields:fieldNames},null,2));
  process.exit(0);
}
if(!nonNative.length){
  console.log(JSON.stringify({status:"INCONCLUSIVE_NO_RECENT_NON_NATIVE_TRADE_EVENTS",quoteField,decodedTrades:trades.length},null,2));
  process.exit(0);
}
console.log(JSON.stringify({status:"NON_NATIVE_VOLUME_EVIDENCE_FOUND",quoteField,volumeField,amountFields,count:nonNative.length,samples:nonNative.slice(0,10)},null,2));
