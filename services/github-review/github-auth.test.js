// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {GitHubAuth}=require("./github-auth.js");
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"app-auth-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const keys=crypto.generateKeyPairSync("rsa",{modulusLength:2048});const key=path.join(dir,"key.pem");fs.writeFileSync(key,keys.privateKey.export({type:"pkcs8",format:"pem"}));return {keys,config:{githubAuth:{mode:"app",appId:1,installationId:2,privateKeyFile:key},githubTokenFile:"/must-not-read-pat"}};}
test("installation refresh coalesces concurrent calls and signs short-lived JWTs",async(t)=>{
 const {keys,config}=fixture(t);let now=Date.now(),issued=0;
 const a=new GitHubAuth(config,async(url,options)=>{issued++;assert.ok(url.endsWith("/installations/2/access_tokens"));assert.equal(options.redirect,"error");const jwt=options.headers.authorization.slice(7).split(".");assert.ok(crypto.verify("RSA-SHA256",Buffer.from(jwt.slice(0,2).join(".")),keys.publicKey,Buffer.from(jwt[2],"base64url")));const claims=JSON.parse(Buffer.from(jwt[1],"base64url"));assert.equal(claims.iss,"1");assert.ok(claims.exp-claims.iat<=600);return {ok:true,json:async()=>({token:`installation-${issued}`,expires_at:new Date(now+3600000).toISOString()})};},()=>now,false);
 assert.deepEqual(await Promise.all([a.getToken(),a.getToken()]),["installation-1","installation-1"]);assert.equal(issued,1);
 now+=46*60000;assert.equal(await a.getToken(),"installation-2");assert.equal(issued,2);
});
test("401 renews once, 403 does not switch credentials, and App failures never fall back to PAT",async(t)=>{
 const {config}=fixture(t);let issued=0,requests=0,fail=false;
 const a=new GitHubAuth(config,async(url)=>{
  if(url.endsWith("access_tokens")){if(fail)return {ok:false,status:403};issued++;return {ok:true,json:async()=>({token:`t${issued}`,expires_at:new Date(Date.now()+3600000).toISOString()})};}
  requests++;return {ok:false,status:requests===1?401:403};
 },Date.now,false);
 assert.equal((await a.request("https://api.github.com/repos/o/r")).status,403);assert.equal(issued,2);assert.equal(requests,2);
 await assert.rejects(a.request("https://evil.test"),/destination/);
 a.cached=null;fail=true;await assert.rejects(a.getToken(),/HTTP 403/);
});
test("App bot identity uses app JWT rather than installation /user endpoint",async(t)=>{
 const {config}=fixture(t);const a=new GitHubAuth(config,async(url)=>{assert.equal(url,"https://api.github.com/app");return {ok:true,json:async()=>({slug:"ocr"})};},Date.now,false);
 assert.equal((await a.user()).data.login,"ocr[bot]");
});
