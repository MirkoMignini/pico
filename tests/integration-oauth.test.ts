import { afterEach, expect, it, vi } from 'vitest';
import type { Credential } from '@earendil-works/pi-ai';
import type { Credentials } from '../src/credentials.js';
import { OAuthLogin } from '../src/features/integrations/oauth.js';

const realFetch=globalThis.fetch,logins:OAuthLogin[]=[];
const secret='SYNTHETIC_PRIVATE_SECRET',code='SYNTHETIC_AUTHORIZATION_CODE';
const grant={access_token:'SYNTHETIC_NEW_ACCESS',refresh_token:'SYNTHETIC_NEW_REFRESH',expires_in:3600,scope:'openid'};
function fixture(){
  let saved:Credential={type:'oauth',access:'SYNTHETIC_PRIOR_ACCESS',refresh:'SYNTHETIC_PRIOR_REFRESH',expires:1};
  const credentials:Pick<Credentials,'secret'|'modify'>={secret:vi.fn(async()=>secret),modify:vi.fn(async(_provider,update)=>{saved=await update(saved)??saved;return saved;})};
  const login=new OAuthLogin(credentials,{clientId:'synthetic-client',credentialKey:'synthetic',secretName:'synthetic.clientSecret',authorizationEndpoint:'https://oauth.example.test/authorize',tokenEndpoint:'https://oauth.example.test/token',scopes:['openid']});
  logins.push(login);return {login,credentials,saved:()=>saved};
}
async function callback(login:OAuthLogin,denied=false){
  const start=await login.start(),params=new URLSearchParams({state:new URL(start.url).searchParams.get('state')!,...(denied?{error:'access_denied',error_description:secret}:{code})});
  const response=await realFetch(`${start.redirectUri}?${params}`);
  return {status:response.status,cache:response.headers.get('cache-control'),text:await response.text()};
}
afterEach(()=>{for(const login of logins.splice(0))login.close();vi.restoreAllMocks();});

it.each([
  {body:{error:'invalid_client',error_description:secret,access_token:secret},expectedCode:'invalid_client'},
  {body:{error:'invalid_grant',error_description:secret},expectedCode:'invalid_grant'},
  {body:{error:secret,error_description:secret},expectedCode:undefined},
  {body:null,expectedCode:undefined}
])('reports only safe token-exchange diagnostics without changing credentials ($expectedCode)',async({body,expectedCode})=>{
  const s=fixture(),fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(body,{status:400}));
  const response=await callback(s.login);
  expect(response).toMatchObject({status:400,cache:'no-store'});
  expect(s.login.failure).toEqual({stage:'token-exchange',httpStatus:400,...(expectedCode?{code:expectedCode}:{})});
  expect(response.text).toContain('token-exchange');expect(response.text).not.toContain(secret);expect(response.text).not.toContain(code);
  expect(s.login.status).toBe('failed');expect(s.saved()).toMatchObject({access:'SYNTHETIC_PRIOR_ACCESS'});expect(s.credentials.modify).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['invalid JSON','x'.repeat(65_000)])('bounds and sanitizes non-JSON or oversized token errors (%#)',async body=>{
  const s=fixture();vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(body,{status:401}));
  const response=await callback(s.login);expect(s.login.failure).toEqual({stage:'token-exchange',httpStatus:401});expect(response.text.length).toBeLessThan(400);expect(s.credentials.modify).not.toHaveBeenCalled();
});
it.each([
  {tokens:{...grant,access_token:secret,expires_in:0},stage:'token-response',expectedCode:undefined},
  {tokens:{...grant,refresh_token:undefined},stage:'offline-grant',expectedCode:'missing_refresh_token'},
  {tokens:{...grant,scope:''},stage:'consent-scopes',expectedCode:'scope_mismatch'},
  {tokens:{...grant,scope:'openid unexpected-scope'},stage:'consent-scopes',expectedCode:'scope_mismatch'}
])('identifies $stage while preserving exact offline-consent validation',async({tokens,stage,expectedCode})=>{
  const s=fixture();vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(tokens));
  const response=await callback(s.login);expect(s.login.failure).toEqual({stage,...(expectedCode?{code:expectedCode}:{})});expect(response.text).not.toContain(secret);expect(response.text).not.toContain('unexpected-scope');expect(s.credentials.modify).not.toHaveBeenCalled();
});
it.each(['client-credentials','token-exchange','account-validation','credential-storage'])('does not expose thrown errors at %s',async stage=>{
  const s=fixture();vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(grant));
  if(stage==='client-credentials')vi.mocked(s.credentials.secret).mockRejectedValue(new Error(secret));
  if(stage==='token-exchange')vi.mocked(globalThis.fetch).mockRejectedValue(new Error(secret));
  if(stage==='account-validation')s.login.config.prepareGrant=async()=>{throw new Error(secret);};
  if(stage==='credential-storage')vi.mocked(s.credentials.modify).mockRejectedValue(new Error(secret));
  const response=await callback(s.login);expect(s.login.failure).toEqual({stage});expect(response.text).not.toContain(secret);expect(s.saved()).toMatchObject({access:'SYNTHETIC_PRIOR_ACCESS'});
});
it('reports declined consent without contacting the provider or echoing callback parameters',async()=>{
  const s=fixture(),fetch=vi.spyOn(globalThis,'fetch');const response=await callback(s.login,true);
  expect(s.login.failure).toEqual({stage:'authorization'});expect(response.text).not.toContain(secret);expect(fetch).not.toHaveBeenCalled();expect(s.credentials.modify).not.toHaveBeenCalled();
});
it('clears previous failure on a fresh login and publishes success only after storing the grant',async()=>{
  const s=fixture(),fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({error:'invalid_client'},{status:400}));
  await callback(s.login);expect(s.login.failure?.code).toBe('invalid_client');
  fetch.mockResolvedValueOnce(Response.json(grant));const response=await callback(s.login);
  expect(response.status).toBe(200);expect(s.login.status).toBe('completed');expect(s.login.failure).toBeUndefined();expect(s.saved()).toMatchObject({access:grant.access_token,refresh:grant.refresh_token,scopes:['openid']});
});
