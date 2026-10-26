import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function snippet(name){
 const marker=source.includes('async function '+name+'(')?'async function '+name+'(':'function '+name+'(';
 const start=source.indexOf(marker);assert.ok(start>=0,'Missing app function '+name);
 let braces=0,quote='',escaped=false;
 for(let i=source.indexOf('{',start);i<source.length;i++){
  const char=source[i];
  if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote='';continue;}
  if(['\"',"'",'`'].includes(char)){quote=char;continue;}
  if(char==='{')braces++;else if(char==='}'&&--braces===0)return source.slice(start,i+1);
 }
 throw Error('Unclosed app function '+name);
}
const custom=source.includes('function say('),settle=()=>new Promise(resolve=>setImmediate(resolve));
const makeRouteGuard=source.includes('const routeGuard = createRouteGuard()')?(await import('../public/product-view.js')).createRouteGuard:null;
function ui({rejectPost=false}={}){
 let activeElement=null,reads=0,posts=0,created=0,failRefresh=true;
 const all=node=>[node,...node.children.flatMap(all)];
 class Element{
  constructor(tag,text='',className=''){this.tagName=tag;this.textContent=text;this.className=className;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.fields={};this.disabled=false;this.resetCount=0;this.parent=null;this.classList={add:name=>{this.className+=' '+name;},toggle:()=>{}};}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  replaceChildren(...children){for(const child of this.children)child.parent=null;this.children=[];this.append(...children);}
  setAttribute(key,value){this.attributes[key]=value;}
  removeAttribute(key){delete this.attributes[key];}
  addEventListener(type,handler){this.listeners[type]=handler;}
  querySelector(selector){return selector==='[data-loading]'?null:all(this).find(node=>selector[0]==='.'&&node.className.split(' ').includes(selector.slice(1)))||null;}
  reset(){this.resetCount++;this.fields={};}
  focus(){activeElement=this;}
  get isConnected(){return this===screen||!!this.parent?.isConnected;}
 }
 const screen=new Element('main'),notice=new Element('div'),api=async(path,method='GET',data)=>{
  if(path==='/api/users'&&method==='POST'){created++;return {username:data.username,role:data.role};}
  if(path==='/api/users')return {users:[{name:'synthetic_employee',role:'operator'}]};
  if(method==='POST'){posts++;if(rejectPost)throw Error('Synthetic revocation refused');return {username:'employee',revoked:2,keptCurrent:false};}
  if(++reads>1&&failRefresh)throw Error('Synthetic summary refresh failed');
  return {serverTime:0,currentSessionExpires:28800000,users:[{name:'employee',role:'operator',activeSessions:posts?0:2,earliestExpiry:28800000,latestExpiry:28800000,isCurrentUser:false}]};
 };
 const E=(tag,text,cls)=>new Element(tag,text,cls),field=(form,label,name,value='')=>{const item=E('input');item.name=name;item.value=value;form.append(item);return item;};
 const sandbox={screen,notice,E,api,Date,routeGuard:makeRouteGuard?.(),user:{name:'admin',role:'admin'},state:{revision:1},staff:[],config:{slug:'synthetic'},location:{reload(){}},chrome(){},focusTitle(){},list(){},render(){},download(){},field,input:(form,name,label,value)=>field(form,label,name,value),select:(form,label,name)=>field(form,label,name),FormData:class{constructor(form){this.fields=form.fields;}[Symbol.iterator](){return Object.entries(this.fields)[Symbol.iterator]();}}};
 const context=vm.createContext(sandbox);
 vm.runInContext(snippet(custom?'say':'message')+'\n'+snippet('run'),context);
 const action=(label,fn,cls='secondary')=>{const b=E('button',label,cls);b.type='button';b.listeners.click=()=>context.run(fn,b);return b;};context.button=action;context.B=action;
 vm.runInContext(snippet('accountSessions')+'\n'+snippet('settings'),context);
 return {screen,notice,context,all:()=>all(screen),active:()=>activeElement,counts:()=>({posts,created}),restoreRefresh:()=>{failRefresh=false;},start:()=>{context.accountSessions(custom?context.say:context.message);},settings:()=>context.settings()};
}

test('committed revocation remains confirmed after refresh failure; retry refresh never resends mutation',async()=>{
 const view=ui();view.start();await settle();
 const revoke=view.all().find(node=>node.attributes['aria-label']==='Завершить все сеансы: employee');
 await revoke.listeners.click();await settle();
 assert.equal(view.counts().posts,1);assert.match(view.notice.textContent,/Завершено действующих сеансов: 2/);assert.match(view.notice.textContent,/не обновл/);
 assert.equal(view.active(),view.notice);assert.equal(revoke.isConnected,false,'Committed operation must not leave a stale revoke action attached.');
 view.restoreRefresh();const refresh=view.all().find(node=>node.textContent==='Обновить сеансы');await refresh.listeners.click();
 assert.equal(view.counts().posts,1);assert.equal(view.all().find(node=>node.attributes['aria-label']==='Завершить все сеансы: employee').disabled,true);
});

test('refused revocation retains its action and focuses the real refusal without success claim',async()=>{
 const view=ui({rejectPost:true});view.start();await settle();
 const revoke=view.all().find(node=>node.attributes['aria-label']==='Завершить все сеансы: employee');await revoke.listeners.click();
 assert.equal(view.notice.textContent,'Synthetic revocation refused');assert.equal(view.active(),view.notice);assert.equal(revoke.isConnected,true);assert.equal(revoke.disabled,false);
});

test('created account is confirmed once even when its follow-up list fails',async()=>{
 const view=ui();view.settings();await settle();
 const form=view.all().find(node=>node.tagName==='form'&&(node.listeners.submit||node.onsubmit));
 form.fields={username:'synthetic_employee',password:'Synthetic-only-password',role:'operator'};
 (form.listeners.submit||form.onsubmit)({preventDefault(){}});await settle();
 assert.equal(view.counts().created,1);assert.equal(form.resetCount,1);assert.match(view.notice.textContent,/создан/);assert.match(view.notice.textContent,/не обновл/);assert.equal(view.active(),view.notice);
 if(source.includes('staff=[]'))assert.ok(vm.runInContext("staff.some(account=>account.name==='synthetic_employee'&&account.role==='operator')",view.context));
});

function apiContext(fetcher){
 let logins=0;const context=vm.createContext({routeGuard:makeRouteGuard?.(),fetch:fetcher||async function(){return {ok:false,status:401,json:async()=>({error:'Войдите в рабочий кабинет.'})};},login:()=>{logins++;}});
 vm.runInContext("let user={name:'synthetic_employee',csrf:'synthetic'},state={revision:1},staff=[{name:'synthetic_employee'}];\n"+snippet('api'),context);
 return {context,logins:()=>logins};
}
test('protected and logout401 clear stale identity and expose login without page reload',async()=>{
 for(const path of ['/api/state','/api/logout']){
  const view=apiContext();await assert.rejects(vm.runInContext(`api('${path}','${path.endsWith('logout')?'POST':'GET'}')`,view.context));
  assert.equal(vm.runInContext('user',view.context),null);assert.equal(vm.runInContext('state',view.context),null);assert.equal(view.logins(),1);
 }
 if(makeRouteGuard){
  let resolve;const response=new Promise(done=>{resolve=done;}),view=apiContext(()=>response);
  const pending=vm.runInContext("api('/api/state')",view.context);view.context.routeGuard.next();
  resolve({ok:false,status:401,json:async()=>({error:'Synthetic stale-route401'})});await assert.rejects(pending);
  assert.equal(vm.runInContext('user.name',view.context),'synthetic_employee');assert.equal(view.logins(),0,'A superseded route must not replace the current screen.');
 }
});

test('login401 preserves the current login form instead of recursively reopening it',async()=>{
 const view=apiContext();await assert.rejects(vm.runInContext("api('/api/login','POST',{username:'synthetic_employee',password:'bad'})",view.context));
 assert.equal(view.logins(),0);assert.equal(vm.runInContext('user.name',view.context),'synthetic_employee');
});
