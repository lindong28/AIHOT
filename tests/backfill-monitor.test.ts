import test from "node:test";
import { execFileSync } from "node:child_process";

test("unified backfill monitor retains partial failures and retires only the legacy preparation alert", () => {
  execFileSync("python3", ["-c", `
import importlib.util,json,pathlib,tempfile,sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('probe','deploy/production/backfill-probe.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
units={'aihot-backfill.timer':{'LoadState':'loaded','ActiveState':'active'},'aihot-backfill.service':{'LoadState':'loaded','ActiveState':'inactive','Result':'success'}}
run={'id':'full','scope':'history','state':'ready','totals':{'failed':1}}
report={'runs':[run],'preparation':{'unresolvedErrors':73}}
assert set(m.problems(report,units))=={'batch:full'}
run['totals']['failed']=0
assert m.problems(report,units)=={}
for bad in [None,-1,'0',True]:
 run['totals']['failed']=bad
 try:m.problems(report,units)
 except ValueError:pass
 else:raise AssertionError('invalid unified failure count accepted')
run['totals']['failed']=0
with tempfile.TemporaryDirectory() as temp:
 home=pathlib.Path(temp);state=home/'.local/state/aihot/backfill-probe.json';state.parent.mkdir(parents=True)
 state.write_text(json.dumps({'preparation':'old issue'}))
 sent=[]
 with patch.object(m,'read_status',return_value=(report,units)),patch.object(m.Path,'home',return_value=home),patch.object(m,'notify',side_effect=lambda binary,args:sent.append(args)),patch.object(sys,'argv',['probe']):m.main()
 assert len(sent)==2 and sent[1]==['--dedup-clear','aihot-backfill:tencent-webserver-china:preparation']
 assert '旧初筛告警退役' in sent[0][-1] and '不代表旧异常已解决' in sent[0][-1]
 assert json.loads(state.read_text())=={}
`], { stdio: "pipe" });
});
