// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs"), crypto = require("node:crypto");
class GitHubAuth {
  constructor(config, request = fetch, now = Date.now, timers = true) {
    this.config = config; this.fetch = request; this.now = now; this.timers = timers;
    this.app = config.githubAuth?.mode === "app"; this.cached = null; this.inflight = null;
    if (config.githubAuth?.mode && !["app", "pat"].includes(config.githubAuth.mode)) throw Error("Invalid GitHub authentication mode");
    if (this.app) {
      const a=config.githubAuth;
      if (![a.appId,a.installationId].every(x=>/^\d+$/.test(String(x))) || !a.privateKeyFile) throw Error("GitHub App configuration incomplete");
    }
  }
  jwt() {
    const a=this.config.githubAuth, now=Math.floor(this.now()/1000);
    const encode=x=>Buffer.from(JSON.stringify(x)).toString("base64url");
    const input=`${encode({alg:"RS256",typ:"JWT"})}.${encode({iat:now-60,exp:now+540,iss:String(a.appId)})}`;
    return `${input}.${crypto.sign("RSA-SHA256",Buffer.from(input),fs.readFileSync(a.privateKeyFile)).toString("base64url")}`;
  }
  async appRequest(route, method="GET") {
    const r=await this.fetch(`https://api.github.com${route}`,{method,redirect:"error",signal:AbortSignal.timeout(20000),
      headers:{authorization:`Bearer ${this.jwt()}`,accept:"application/vnd.github+json","user-agent":"ocr-github-app","x-github-api-version":"2022-11-28"}});
    if(!r.ok) throw Error(`GitHub App authentication HTTP ${r.status}`);
    return r.json();
  }
  getToken() {
    if(!this.app) {
      const token=this.config.githubTokenFile ? fs.readFileSync(this.config.githubTokenFile,"utf8").trim() : this.config.token;
      if(!token) throw Error("GitHub credential missing"); return token;
    }
    if(this.cached && this.cached.expiresAt-this.now()>15*60000) return Promise.resolve(this.cached.token);
    if(this.inflight) return this.inflight;
    this.inflight=this.appRequest(`/app/installations/${this.config.githubAuth.installationId}/access_tokens`,"POST").then(value=>{
      const expiresAt=Date.parse(value.expires_at);
      if(typeof value.token!=="string" || !value.token || !(expiresAt-this.now()>15*60000)) throw Error("Invalid GitHub installation token response");
      this.cached={token:value.token,expiresAt};
      this.schedule(Math.max(1000,expiresAt-this.now()-14*60000));
      return value.token;
    }).finally(()=>{this.inflight=null;});
    return this.inflight;
  }
  schedule(delay) {
    if(!this.timers)return;clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.getToken().catch(()=>this.schedule(60000));},delay);this.timer.unref();
  }
  async request(url, options={}) {
    if(new URL(url).origin!=="https://api.github.com") throw Error("GitHub credential destination rejected");
    const token=await this.getToken();
    const send=t=>this.fetch(url,{...options,redirect:"error",headers:{...options.headers,authorization:`Bearer ${t}`}});
    let response=await send(token);
    if(this.app && response.status===401){
      if(this.cached?.token===token)this.cached=null;
      response=await send(await this.getToken());
    }
    return response;
  }
  async user() {
    if(!this.app)throw Error("App identity unavailable in PAT mode");
    if(!this.login){const app=await this.appRequest("/app");if(!app.slug)throw Error("GitHub App identity missing");this.login=app.slug+"[bot]";}
    return {data:{login:this.login,type:"Bot"}};
  }
}
const providers=new WeakMap();
function githubAuth(config, request=fetch) {
  if(!providers.has(config))providers.set(config,new WeakMap());
  const byRequest=providers.get(config);
  if(!byRequest.has(request))byRequest.set(request,new GitHubAuth(config,request));
  return byRequest.get(request);
}
module.exports={GitHubAuth,githubAuth};
