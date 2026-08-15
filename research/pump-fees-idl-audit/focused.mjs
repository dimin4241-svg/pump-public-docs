import fs from "node:fs";
const idl=JSON.parse(fs.readFileSync(new URL("../../idl/pump_fees.json", import.meta.url),"utf8"));
const rx=/withdraw|sweep|claim|buyback|donation|social|sharing|transfer|distribut/i;
for(const ix of idl.instructions.filter(x=>rx.test(x.name))){
  console.log(`\n=== ${ix.name} ===`);
  console.log(`args=${JSON.stringify(ix.args)}`);
  for(const a of ix.accounts){
    console.log(JSON.stringify({name:a.name,signer:!!a.signer,writable:!!a.writable,relations:a.relations||[],pda:!!a.pda,address:a.address||null,optional:!!a.optional,docs:a.docs||[]}));
  }
}
