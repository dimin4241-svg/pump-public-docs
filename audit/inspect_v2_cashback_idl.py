import json
idl=json.load(open('idl/pump_amm.json'))
for name in ['init_user_volume_accumulator','claim_cashback','close_user_volume_accumulator','create_pool_v2','buy','sell']:
    x=next((i for i in idl['instructions'] if i['name']==name),None)
    if not x: continue
    print('\n===',name,'===')
    print('disc',x.get('discriminator'))
    for n,a in enumerate(x.get('accounts',[])):
        p=a.get('pda')
        seeds=[]
        if p:
            for s in p.get('seeds',[]):
                seeds.append({k:v for k,v in s.items() if k in ('kind','path','value','account')})
        print(n, json.dumps({'name':a['name'],'signer':a.get('signer',False),'writable':a.get('writable',False),'address':a.get('address'),'relations':a.get('relations'),'pda_seeds':seeds,'pda_program':(p or {}).get('program')},separators=(',',':')))
    print('args',json.dumps(x.get('args',[]),separators=(',',':')))
print('\n=== ACCOUNT TYPES ===')
for name in ['PoolV2','UserVolumeAccumulator','GlobalVolumeAccumulator']:
    a=next((x for x in idl.get('accounts',[]) if x['name'].lower()==name.lower()),None)
    t=next((x for x in idl.get('types',[]) if x['name'].lower()==name.lower()),None)
    print(name,'account',json.dumps(a,separators=(',',':')),'type',json.dumps(t,separators=(',',':')))
print('\n=== ERRORS 6050-6062 ===')
for e in idl.get('errors',[]):
    if 6050 <= e['code'] <= 6062: print(json.dumps(e,separators=(',',':')))
