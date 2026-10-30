// Optional development tests: node tests/audit.cjs (no packages required).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} differs from ${b}`);
const models = vm.createContext({ assert });
vm.runInContext(source.split('const $ =')[0] + '\nglobalThis.Model = TrafficSimulation; globalThis.Bucket = TokenBucket;', models);

// Independent fluid-credit reference: no animation frames or production methods.
function reference(c) {
  let time = 0, arrivalIndex = 1, slot = 1, balance = c.tokenCapacity;
  const l = {queue:[], history:[]}, t = {queue:[], history:[]};
  const send = (bucket, at) => { bucket.queue.shift().transmissionTime = at; };
  while (true) {
    const arrival = arrivalIndex / c.arrival, departure = slot / c.output;
    const ready = t.queue.length ? time + Math.max(0, 1 - balance) / c.tokenRate : Infinity;
    const next = Math.min(arrival, departure, ready);
    if (next > c.duration + 1e-10) break;
    balance = Math.min(c.tokenCapacity, balance + (next - time) * c.tokenRate);
    time = next;
    while (t.queue.length && balance >= 1 - 1e-9) { send(t, time); balance = Math.max(0, balance - 1); }
    if (departure <= next + 1e-10) { slot++; if (l.queue.length) send(l, departure); }
    if (arrival <= next + 1e-10) {
      for (const [name,bucket] of [['leaky',l],['token',t]]) {
        const p = {id:arrivalIndex, arrivalTime:arrival, transmissionTime:null, dropTime:null};
        bucket.history.push(p);
        if (name === 'token' && !bucket.queue.length && balance >= 1 - 1e-9) {
          p.transmissionTime = time; balance = Math.max(0, balance - 1);
        } else if ((name === 'leaky' || c.policy === 'queue') && bucket.queue.length < c.buffer) bucket.queue.push(p);
        else p.dropTime = time;
      }
      arrivalIndex++;
    }
  }
  return {leaky:l, token:t};
}

const defaults = {arrival:12,output:8,buffer:30,tokenRate:10,tokenCapacity:20,duration:10,policy:'queue'};
const cases = [
  ['Low traffic',{arrival:2}],
  ['High traffic / initial burst',{arrival:100}],
  ['Small buffer',{arrival:40,buffer:1}],
  ['Low token generation',{arrival:12,tokenRate:.25,tokenCapacity:2}],
  ['High token capacity',{arrival:50,tokenRate:.1,tokenCapacity:1000}],
  ['Fractional rates',{arrival:13.37,output:7.125,tokenRate:2.75,duration:17}],
];
const results=[];
for (const [title, values] of cases) for (const policy of ['queue','drop']) {
  const c={...defaults,...values,policy};
  const sim=new models.Model(c), expected=reference(c);
  // Uneven time steps represent varying frame rates.
  while (sim.time < c.duration) sim.step(Math.min(.037, c.duration - sim.time));
  const row={case:title,policy,incoming:sim.received};
  for (const name of ['leaky','token']) {
    const bucket=sim[name], ref=expected[name];
    assert.equal(bucket.history.length,ref.history.length);
    let waits=0, sent=0, dropped=0, lastId=0, lastTransmission=-Infinity;
    bucket.history.forEach((packet,i)=>{
      const other=ref.history[i];
      assert.equal(packet.id,other.id); near(packet.arrivalTime,other.arrivalTime);
      assert.equal(packet.dropTime===null,other.dropTime===null);
      assert.equal(packet.transmissionTime===null,other.transmissionTime===null);
      assert.equal(packet.id,sim.leaky.history[i].id);
      near(packet.arrivalTime,sim.leaky.history[i].arrivalTime);
      if(packet.transmissionTime!==null) {
        near(packet.transmissionTime,other.transmissionTime);
        assert.ok(packet.id>lastId); lastId=packet.id;
        assert.ok(packet.transmissionTime>=packet.arrivalTime-1e-9);
        if(name==='leaky') assert.ok(packet.transmissionTime-lastTransmission>=1/c.output-1e-8);
        lastTransmission=packet.transmissionTime;
        waits+=packet.transmissionTime-packet.arrivalTime; sent++;
      }
      if(packet.dropTime!==null) dropped++;
    });
    near(waits,bucket.delay); assert.equal(sent,bucket.sent); assert.equal(dropped,bucket.dropped);
    assert.equal(sent+dropped+bucket.queue.length,sim.received);
    assert.ok(bucket.queue.length<=c.buffer);
    assert.ok(bucket.events.length<=160);
    row[name]={sent,dropped,queued:bucket.queue.length,averageWaitMs:sent?waits/sent*1000:null,throughput:sent/sim.time};
  }
  assert.ok(sim.tokens>=0 && sim.tokens<=c.tokenCapacity);
  near(c.tokenCapacity+sim.token.generatedCredits,sim.token.sent+sim.tokens);
  if(policy==='drop') assert.equal(sim.token.queue.length,0);
  results.push(row);
}

// True instantaneous bursts after a quiet refill interval.
const burst=new models.Bucket(5,.5,2,'queue');
for(let id=1;id<=5;id++) burst.receivePacket({id,arrivalTime:0});
assert.equal(burst.tokens,0); assert.equal(burst.sent,5);
burst.advanceTo(10); assert.equal(burst.tokens,5);
for(let id=6;id<=15;id++) burst.receivePacket({id,arrivalTime:10});
assert.equal(burst.sent,10); assert.equal(burst.queue.length,2); assert.equal(burst.dropped,3);
burst.advanceTo(14); assert.equal(burst.sent,12);
near(burst.history[10].transmissionTime,12); near(burst.history[11].transmissionTime,14);
// Configuration rejects values that could cause infinite loops or invalid queues.
for(const change of [{arrival:0},{output:NaN},{tokenRate:Infinity},{buffer:1.5},{tokenCapacity:-1},{policy:'invalid'}]) {
  assert.throws(()=>new models.Model({...defaults,...change}));
}
// Maximum permitted workload: counters remain conserved and visuals remain bounded.
const max=new models.Model({...defaults,arrival:500,output:500,tokenRate:500,buffer:1000,tokenCapacity:1000,duration:600});
max.step(600);
assert.equal(max.received,300000);
for(const name of ['leaky','token']) {
  const b=max[name]; assert.equal(b.sent+b.dropped+b.queue.length,300000); assert.ok(b.events.length<=160);
}

// Browser-independent UI harness. Real Chart.js drawing and CSS are separate checks.
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const nodes=new Map();
for(const match of html.matchAll(/id="([^"]+)"/g)) {
  assert.ok(!nodes.has(match[1]),'Duplicate DOM id');
  nodes.set(match[1],{textContent:'',children:[],style:{},disabled:false,hidden:true,
    handlers:{},name:match[1],classList:{toggle(){}},replaceChildren(...children){this.children=children},
    addEventListener(event,fn){assert.ok(!this.handlers[event]);this.handlers[event]=fn}});
}
const fields=['arrival','output','buffer','tokenRate','tokenCapacity','duration','policy'].map(id=>nodes.get(id));
const form=nodes.get('config-form');
let valid=true, config={...defaults,duration:3.5}, now=0, nextId=0;
const pending=new Map();
form.querySelectorAll=()=>fields;form.checkValidity=form.reportValidity=()=>valid;
class ChartStub { constructor(canvas,options){this.data=options.data;this.options=options.options} update(){} }
const context=vm.createContext({assert, Chart:ChartStub,
  document:{createElement:()=>({style:{}}),getElementById(id){assert.ok(nodes.has(id),'Missing DOM id '+id);return nodes.get(id)},querySelectorAll:()=>[],body:{classList:{toggle(){}}}},
  FormData:class{constructor(){return Object.entries(config)}},performance:{now:()=>now},
  requestAnimationFrame(fn){pending.set(++nextId,fn); assert.ok(pending.size<=1,'Duplicate animation loop');return nextId},
  cancelAnimationFrame(id){pending.delete(id)}});
vm.runInContext(source,context);
const run=code=>vm.runInContext(code,context);
function tick(timestamp){now=timestamp;const callbacks=[...pending.values()];pending.clear();callbacks.forEach(fn=>fn(now));}
const submit=()=>form.handlers.submit({preventDefault(){}});
assert.equal(run('engine.tokens'),0);
assert.equal(run('charts.length'),4);
valid=false; submit();assert.equal(pending.size,0);valid=true;
for(let cycle=0;cycle<25;cycle++) {
  submit();submit();assert.equal(pending.size,1);assert.ok(fields.every(f=>f.disabled));
  tick(now+1100);const before=run('engine.time');
  nodes.get('pause').handlers.click();assert.equal(pending.size,0);
  tick(now+5000);assert.equal(run('engine.time'),before);
  nodes.get('resume').handlers.click();nodes.get('resume').handlers.click();assert.equal(pending.size,1);
  tick(now+5000);assert.equal(run('state'),'complete');assert.equal(pending.size,0);
  assert.equal(nodes.get('conclusion').hidden,false);
  run(`charts.forEach((chart,i)=>{
    assert.deepEqual(Array.from(chart.data.labels),[0,1,2,3,3.5]);
    for(let j=0;j<2;j++) assert.equal(chart.data.datasets[j].data.at(-1),comparisonMetrics(engine)[j?'token':'leaky'][CHART_METRICS[i].key]);
  });`);
  nodes.get('reset').handlers.click();
  assert.equal(pending.size,0);assert.ok(fields.every(f=>!f.disabled));
  assert.equal(run('engine.tokens'),0);assert.equal(run('engine.received'),0);
  assert.equal(run('engine.leaky.history.length+engine.token.history.length'),0);
  assert.equal(run('engine.leaky.queue.length+engine.token.queue.length'),0);
  assert.equal(nodes.get('token-credit-events').children.length,0);
  assert.equal(nodes.get('token-packet-events').children.length,0);
  assert.equal(nodes.get('leaky-packet-events').children.length,0);
  assert.equal(nodes.get('conclusion').hidden,true);
  assert.equal(run('charts.every(chart=>chart.data.labels.length===1)'),true);
}
// Editing and reset midway through an invalid edit cannot create an invalid model.
config={...defaults,arrival:2,duration:1};form.handlers.input();assert.equal(run('engine.config.arrival'),2);
valid=false;nodes.get('reset').handlers.click();valid=true;
assert.equal(run('engine.config.arrival'),2);
// CDN failure must not throw or block the simulation.
context.Chart=undefined;run('initCharts()');assert.equal(nodes.get('chart-message').hidden,false);
console.log(JSON.stringify(results,null,2));
console.log('PASS: 12 reference-checked traffic/policy cases, refill burst, invalid inputs, maximum workload, 25 start/pause/resume/complete/reset cycles, chart data, shared clock, bounded animation buffers, and offline fallback.');
