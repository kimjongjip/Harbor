import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const requests=[];
const markdown='# Inline figures\n\n![Relative figure](figures/chart.svg)\n\n![Absolute figure](/project/absolute.svg)\n\n![Missing figure](missing.svg)';
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160"><rect width="640" height="160" fill="#dbeafe"/><text x="24" y="85" font-size="24">Inline document figure</text></svg>';
let server,browser;
try {
 server=await createServer({server:{host:'127.0.0.1',port:0},plugins:[{name:'inline-images-fixture',configureServer(vite){vite.middlewares.use((req,res,next)=>{
  if(!req.url.startsWith('/api/'))return next();
  const url=new URL(req.url,'http://fixture');res.setHeader('Content-Type','application/json');
  if(url.pathname==='/api/bootstrap')return res.end(JSON.stringify({token:'fixture',state:{hosts:[{id:'fixture',name:'Fixture',kind:'ssh'}]}}));
  if(url.pathname.endsWith('/files/image')){assert.equal(url.searchParams.get('token'),'fixture');res.setHeader('Content-Type','image/svg+xml');return res.end(svg);}
  if(url.pathname.endsWith('/files/download')){assert.equal(req.headers['x-harbor-token'],'fixture');res.setHeader('Content-Type','application/octet-stream');return res.end(svg);}
  if(url.pathname.endsWith('/files/preview')){
   const p=url.searchParams.get('path');requests.push({path:p,cwd:url.searchParams.get('cwd')});
   if(p==='/project/docs/readme.md')return res.end(JSON.stringify({kind:'text',path:p,name:'readme.md',text:markdown}));
   if(p==='missing.svg'){res.statusCode=404;return res.end(JSON.stringify({error:'Missing fixture image'}));}
   return res.end(JSON.stringify({kind:'text',path:p.startsWith('/')?p:'/project/docs/'+p,name:'chart.svg',text:'<svg',truncated:true}));
  }res.statusCode=404;res.end('{}');
 });}}]});
 await server.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1100,height:850}});
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?preview=1#${new URLSearchParams({target:JSON.stringify({hostId:'fixture',path:'/project/docs/readme.md',cwd:'~'})})}`);
 await page.waitForFunction(()=>document.querySelectorAll('.markdown-inline-image > img').length===2 && [...document.querySelectorAll('.markdown-inline-image > img')].every(i=>i.complete&&i.naturalWidth>0));
 await page.getByText('Missing fixture image',{exact:true}).waitFor();
 assert.ok(requests.some(r=>r.path==='figures/chart.svg'&&r.cwd==='/project/docs'));
 assert.ok(requests.some(r=>r.path==='/project/absolute.svg'));
 const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'Relative figure',exact:true}).click();const popup=await popupPromise;
 const target=JSON.parse(new URLSearchParams(new URL(popup.url()).hash.slice(1)).get('target'));
 assert.equal(target.cwd,'/project/docs');assert.equal(target.path,'figures/chart.svg');
 await popup.waitForFunction(()=>{const i=document.querySelector('.image-viewer img');return i?.complete&&i.naturalWidth>0;});await popup.close();
 await page.setViewportSize({width:420,height:750});
 assert.ok(await page.locator('.markdown-inline-image > img').first().evaluate(i=>i.getBoundingClientRect().width<=i.parentElement.getBoundingClientRect().width+1));
 await page.setViewportSize({width:1100,height:850});await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/inline-images.png'});
 await writeFile('artifacts/inline-images-verification.json',JSON.stringify({passed:true,syntheticOnly:true,relativeAndAbsolute:true,inlineDecodedImages:2,missingImageFallback:true,popup:true,responsive:true},null,2));
 console.log('Inline images, path resolution, popup, failure fallback and responsive sizing: PASS');
} finally {await browser?.close();await server?.close();}
