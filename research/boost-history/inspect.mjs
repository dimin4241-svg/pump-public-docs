import { Connection, PublicKey } from "@solana/web3.js";

const RPC=process.env.DEVNET_RPC||"https://api.devnet.solana.com";
const DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const POOL=new PublicKey("wpYrhqnsfU8LBk2m2U8QGHToGu4b17SA8oAw6vjWxbe");
const POOL_QUOTE=new PublicKey("56u8QgjVPz98yjY7UFfmjYqPsTdmr3ciK31UPNpST7MF");
const BOOST_VAULT=new PublicKey("5DeVwFwyPJaJq6hLVJbxJq1Yst3J3JetyaWS56LjdVAp");

const c=new Connection(RPC,"confirmed");
const genesis=await c.getGenesisHash();
if(genesis!==DEVNET_GENESIS) throw new Error(`SAFETY wrong genesis ${genesis}`);
console.log(`SAFETY_GATE devnet genesis verified: ${genesis}`);

async function allSignatures(address,maxPages=8){
  const out=[]; let before;
  for(let page=0;page<maxPages;page++){
    const batch=await c.getSignaturesForAddress(address,{before,limit:1000},"confirmed");
    out.push(...batch); if(batch.length<1000) break; before=batch.at(-1).signature;
  }
  return out;
}
function tokenBalance(meta,key,which){
  const all=[...(meta?.[which]||[])];
  for(const b of all){
    const accountKeys=meta.__keys||[];
    if(accountKeys[b.accountIndex]===key.toBase58()) return b.uiTokenAmount.amount;
  }
  return null;
}
function keyList(tx){
  const msg=tx.transaction.message;
  const base=msg.staticAccountKeys?.map(String)??msg.accountKeys?.map(String)??[];
  const w=tx.meta?.loadedAddresses?.writable?.map(String)??[];
  const r=tx.meta?.loadedAddresses?.readonly?.map(String)??[];
  return [...base,...w,...r];
}

const sigs=await allSignatures(BOOST_VAULT);
console.log(`BOOST_VAULT_SIGNATURES count=${sigs.length}`);
let init=null;
for(const s of [...sigs].reverse()){
  const tx=await c.getTransaction(s.signature,{commitment:"confirmed",maxSupportedTransactionVersion:0});
  if(!tx) continue;
  const logs=tx.meta?.logMessages||[];
  if(logs.some(l=>l.includes("Instruction: InitBoost"))){init={sig:s,tx};break;}
}
if(!init){
  console.log(JSON.stringify({status:"INCONCLUSIVE_NO_INITBOOST_IN_RETAINED_HISTORY",oldest:sigs.at(-1)?.signature,newest:sigs[0]?.signature},null,2));
  process.exit(3);
}

const keys=keyList(init.tx); init.tx.meta.__keys=keys;
const preQ=tokenBalance(init.tx.meta,POOL_QUOTE,"preTokenBalances");
const postQ=tokenBalance(init.tx.meta,POOL_QUOTE,"postTokenBalances");
const preB=tokenBalance(init.tx.meta,BOOST_VAULT,"preTokenBalances");
const postB=tokenBalance(init.tx.meta,BOOST_VAULT,"postTokenBalances");
console.log("=== INIT_BOOST_TX ===");
console.log(JSON.stringify({signature:init.sig.signature,slot:init.sig.slot,blockTime:init.sig.blockTime,err:init.sig.err,fee:init.tx.meta?.fee,prePoolQuote:preQ,postPoolQuote:postQ,preBoostVault:preB,postBoostVault:postB,accountKeys:keys},null,2));
for(const l of init.tx.meta?.logMessages||[]) console.log(l);
console.log("=== END_INIT_BOOST_TX ===");

// Read pool history and identify nearest earlier/same-slot creation/migration-related txs.
const poolSigs=await allSignatures(POOL,4);
const relevant=[];
for(const s of poolSigs){
  if(s.slot>init.sig.slot||s.slot<init.sig.slot-200) continue;
  const tx=await c.getTransaction(s.signature,{commitment:"confirmed",maxSupportedTransactionVersion:0});
  if(!tx) continue;
  const logs=tx.meta?.logMessages||[];
  const interesting=logs.filter(l=>/Instruction: (CreatePool|Migrate|MigrateV2|InitBoost|Buy|Sell)/.test(l));
  if(interesting.length) relevant.push({signature:s.signature,slot:s.slot,blockTime:s.blockTime,err:s.err,interesting,logs});
}
relevant.sort((a,b)=>a.slot-b.slot);
console.log("=== NEARBY_POOL_TXS ===");
for(const r of relevant){
  console.log(JSON.stringify({signature:r.signature,slot:r.slot,blockTime:r.blockTime,err:r.err,interesting:r.interesting},null,2));
}
console.log("=== END_NEARBY_POOL_TXS ===");

const prior=relevant.filter(r=>r.slot<=init.sig.slot&&r.signature!==init.sig.signature).at(-1);
const sameTxCreate=(init.tx.meta?.logMessages||[]).some(l=>/Instruction: (CreatePool|Migrate|MigrateV2)/.test(l));
console.log(JSON.stringify({status:"INITBOOST_HISTORY_FOUND",initSignature:init.sig.signature,initSlot:init.sig.slot,initBlockTime:init.sig.blockTime,sameTxCreateOrMigrate:sameTxCreate,nearestPriorRelevant:prior?{signature:prior.signature,slot:prior.slot,blockTime:prior.blockTime,interesting:prior.interesting}:null,slotGap:prior?init.sig.slot-prior.slot:null,secondsGap:prior?.blockTime&&init.sig.blockTime?init.sig.blockTime-prior.blockTime:null,balances:{prePoolQuote:preQ,postPoolQuote:postQ,preBoostVault:preB,postBoostVault:postB}},null,2));
