import fs from "node:fs";

const idl=JSON.parse(fs.readFileSync(new URL("../../idl/pump_fees.json", import.meta.url),"utf8"));
const money=/claim|withdraw|distribute|transfer|crank|buyback|fee|donation|social/i;
const candidates=[];
for(const ix of idl.instructions){
  const signers=ix.accounts.filter(a=>a.signer).map(a=>({name:a.name,relations:a.relations||[],pda:!!a.pda,address:a.address||null,writable:!!a.writable}));
  const writable=ix.accounts.filter(a=>a.writable).map(a=>({name:a.name,signer:!!a.signer,relations:a.relations||[],pda:!!a.pda,address:a.address||null,optional:!!a.optional}));
  const looseWritable=writable.filter(a=>!a.signer&&!a.pda&&!a.address&&a.relations.length===0);
  const score=(money.test(ix.name)?3:0)+(looseWritable.length*2)+(signers.some(s=>s.relations.length===0&&!s.pda&&!s.address)?2:0)+(ix.returns?1:0);
  if(score>=3)candidates.push({name:ix.name,score,signers,writable,looseWritable,args:ix.args,returns:ix.returns||null,accounts:ix.accounts.map(a=>({name:a.name,signer:!!a.signer,writable:!!a.writable,relations:a.relations||[],pda:!!a.pda,address:a.address||null,optional:!!a.optional,docs:a.docs||[]}))});
}
candidates.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
console.log(JSON.stringify({program:idl.address,totalInstructions:idl.instructions.length,candidates},null,2));
