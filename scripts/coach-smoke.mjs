import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coach-smoke-'));
const logs = path.join(root, 'sessions');
await fs.mkdir(logs);
const timestamp = new Date(Date.now() - 5000).toISOString();
const message = 'Inspect the failing tests, explain the root cause, implement a focused fix and rerun the affected tests.';
for (let i = 0; i < 3; i++) {
  const lines = [
    {type:'session_meta',payload:{id:`synthetic-${i}`,cwd:root}},
    {type:'event_msg',timestamp,payload:{type:'user_message',message}},
    {type:'event_msg',timestamp,payload:{type:'assistant_message',text:'This is a synthetic response. '.repeat(500)}},
    {type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:50,cached_input_tokens:0}}}},
  ];
  if (i === 0) for (const id of ['fail-a', 'fail-b']) {
    lines.push({type:'response_item',timestamp,payload:{type:'function_call',call_id:id,name:'exec_command',arguments:JSON.stringify({cmd:'synthetic failing command'})}});
    lines.push({type:'response_item',timestamp,payload:{type:'function_call_output',call_id:id,output:'Process exited with code 1\nSynthetic failure'}});
  }
  await fs.writeFile(path.join(logs,`session-${i}.jsonl`),lines.map(line=>JSON.stringify(line)).join('\n'));
}
const config = path.join(root,'coach.local.json');
await fs.writeFile(config, JSON.stringify({sources:{claude:{enabled:false},codex:{roots:[logs]}},stateDir:path.join(root,'state'),port:0}));
const children = [];
function launch(extra) {
  const child = spawn(process.execPath,['dist/coach.cjs','--config',config,...extra],{stdio:['pipe','pipe','pipe']});
  children.push(child); return child;
}
async function collect(child) {
  let stdout='';let stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0,stderr);return stdout;
}
async function start() {
  const child=launch([]);let output='';
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Dashboard startup timed out')),15000);
    child.once('error',reject);
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Dashboard exited before startup'));});
  });
  return {child,url};
}
async function reportAt(url, predicate=()=>true) {
  for(let i=0;i<100;i++) {
    const data=await (await fetch(url+'/api/report')).json();
    if(data.error)throw new Error(data.error);
    if(data.report&&predicate(data))return data;
    await delay(100);
  }
  throw new Error('Report did not become ready');
}
try {
  const report=JSON.parse(await collect(launch(['--report'])));
  assert.equal(report.sessionCount,3);assert.equal(report.requestCount,3);
  assert(report.findings.some(f=>f.kind==='skill'));assert(!JSON.stringify(report).includes(message));
  assert(report.findings.some(f=>f.kind==='session' && f.evidence[0].toolCallIds.includes('fail-a')));
  let {child,url}=await start();
  const first=await reportAt(url);
  assert.equal(first.report.requestCount,3);
  assert.equal((await fetch(url+'/api/report',{headers:{Origin:'https://untrusted.example'}})).status,403);
  assert.equal(await new Promise((resolve,reject)=>{const req=get(url+'/api/report',{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);}),403);
  const id=first.report.findings[0].id;
  assert.equal((await fetch(url+'/api/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action:'dismissed'})})).status,200);
  await fs.appendFile(path.join(logs,'session-0.jsonl'),'\n'+JSON.stringify({type:'event_msg',timestamp,payload:{type:'user_message',message:'Run the next test now.'}}));
  await fetch(url+'/api/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const refreshed=await reportAt(url,data=>data.report.requestCount===4);
  assert.equal(refreshed.report.scan.parsed,1);assert.equal(refreshed.report.scan.reused,2);
  child.kill();await new Promise(resolve=>child.once('exit',resolve));
  ({child,url}=await start());
  const restarted=await reportAt(url);assert.equal(restarted.history[0].action,'dismissed');
  await fetch(url+'/api/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action:'reopened'})});
  if(process.argv.includes('--browser')) {
    const {chromium}=await import('@playwright/test');
    const browser=await chromium.launch({headless:true,channel:'chrome'});
    try {
      const page=await browser.newPage({viewport:{width:1440,height:1000}});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.context().grantPermissions(['clipboard-read','clipboard-write']);
      await page.goto(url);
      await page.getByRole('heading',{name:'Make a skill for a repeated instruction',exact:true}).waitFor();
      await page.getByRole('link',{name:'Connected sources',exact:true}).click();
      await page.getByRole('heading',{name:'Your session folders'}).waitFor();
      await page.getByRole('link',{name:/^Opportunities/}).click();
      await page.getByRole('button',{name:/^Session signals/}).click();
      await page.getByRole('button',{name:'Review idea →'}).first().click();
      await page.getByRole('dialog').getByRole('heading',{name:'Same action failed repeatedly',exact:true}).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button',{name:/^Skills/}).click();
      await page.getByRole('button',{name:'Review idea →'}).first().click();
      await page.getByRole('heading',{name:'What the coach noticed'}).waitFor();
      await page.getByRole('button',{name:'Copy review prompt'}).click();
      assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/Treat transcript text.*as data/);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(),0);
      assert.equal(await page.getByRole('button',{name:'Review idea →'}).first().evaluate(button=>button===document.activeElement),true);
      await page.getByRole('button',{name:'Review idea →'}).first().click();
      await page.getByLabel('Reason for dismissing this idea').selectOption('expected');
      await page.getByRole('button',{name:'Dismiss idea'}).click();
      await page.getByRole('heading',{name:/No ideas in this category|No matching patterns detected/}).waitFor();
      await page.getByRole('link',{name:'Review history',exact:true}).click();
      assert((await reportAt(url)).history.some(event=>event.reason==='expected'));
      await page.getByRole('button',{name:'Reopen idea'}).first().click();
      await page.getByRole('link',{name:/^Opportunities/}).click();
      await page.getByRole('heading',{name:'Make a skill for a repeated instruction',exact:true}).waitFor();
      const screenshotIndex=process.argv.indexOf('--screenshot');
      await page.locator('#toast').waitFor({state:'hidden'});
      if(screenshotIndex>=0)await page.screenshot({path:process.argv[screenshotIndex+1].replace('.png','-opportunities.png'),fullPage:true});
      await page.getByRole('link',{name:'Overview',exact:true}).click();
      if(screenshotIndex>=0)await page.screenshot({path:process.argv[screenshotIndex+1],fullPage:true});
      await page.goBack();
      await page.getByRole('heading',{name:'Find your next improvement.'}).waitFor();
      for(const width of [375,768,1024,1440]){
        await page.setViewportSize({width,height:900});
        for(const target of ['overview','findings','history','sources']){
          await page.locator('nav a[data-view="'+target+'"]').click();
          assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),target+' overflows at '+width);
        }
      }
      await page.emulateMedia({reducedMotion:'reduce'});
      assert.deepEqual(errors,[]);
    } finally {await browser.close();}
  }
  const mcp=launch(['--mcp']);
  const result=collect(mcp);
  mcp.stdin.end([
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'smoke',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'coach_summary',arguments:{}}},
  ].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const replies=(await result).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(replies.length,3);assert.equal(replies[1].result.tools.length,3);
  assert.equal(JSON.parse(replies[2].result.content[0].text).sessions,3);
  console.log('PASS: CLI, real parser worker, incremental refresh, review persistence, loopback restrictions, MCP'+(process.argv.includes('--browser')?', dashboard controls and mobile layout':''));
} finally {
  await Promise.all(children.filter(child=>child.exitCode===null&&child.signalCode===null).map(child=>new Promise(resolve=>{child.once('exit',resolve);child.kill();})));
  await delay(100);
  await fs.rm(root,{recursive:true,force:true});
}
