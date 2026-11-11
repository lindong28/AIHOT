// The private contract is served only by the authenticated API. No secret belongs in this file.
const string = {type:"string"};
const nullableString = {type:["string","null"]};
const date = {type:["string","null"],format:"date-time"};
const ref = (name:string) => ({$ref:`#/components/schemas/${name}`});
const parameter = (name:string,schema:object,description:string) => ({name,in:"query",schema,description});
const selectors = (name:string,description:string) => ({...parameter(name,{type:"array",maxItems:100,items:{type:"string",minLength:1,maxLength:200}},description),style:"form",explode:true});
const queryProperties = {sourceIds:{type:["array","null"],items:string,description:"Resolved union; null means all sources, [] means an explicitly empty group."},timeField:{enum:["effective","published","discovered","updated"]},from:date,to:date,q:nullableString,selected:{type:["boolean","null"]}};
const paging = [parameter("limit",{type:"integer",minimum:1,maximum:100,default:40},"Maximum items per page."),
  parameter("cursor",string,"Opaque cursor; keep all filters unchanged. Live reads, not a transaction snapshot.")];
const summaryProperties = {
  id:string,articleId:nullableString,origin:{enum:["article","material"]},title:string,generatedTitle:nullableString,summary:nullableString,
  url:string,author:nullableString,language:nullableString,sourceId:string,collectionSourceId:string,
  publishedAt:date,discoveredAt:date,sortAt:{...date,description:"Ordering time fixed when first indexed; promotion and revisions do not move a cursor item."},
  indexedAt:{...date,description:"First appearance in the private research projection."},updatedAt:{...date,description:"Current projection update time; not an exhaustive permission/deletion change feed."},
  timeBasis:{enum:["published","discovered"]},revision:{type:["integer","null"]},contentHash:nullableString,selected:{type:"boolean"},
  bodyStatus:{enum:["available","missing","discarded","restricted"]},
  matches:{type:"array",items:{type:"object",required:["field","text"],properties:{field:{enum:["title","summary","body"]},text:string}}},
};
const page = (item:object) => ({type:"object",required:["items","nextCursor","consistency","asOf","changedSinceStart"],properties:{
  items:{type:"array",items:item},nextCursor:nullableString,consistency:{const:"live"},asOf:{type:"string",format:"date-time"},changedSinceStart:{type:"boolean"},
}});
const errors = Object.fromEntries([[400,"Invalid parameters or cursor"],[401,"Missing, invalid or revoked token"],[404,"Disabled, restricted or absent"],[503,"Index not ready, busy or unavailable"]].map(([status,description])=>[String(status),{description,content:{"application/json":{schema:ref("Error")}}}]));
const response = (schema:object,markdown=false) => ({"200":{description:"Current permitted retained data; Cache-Control: no-store",content:{"application/json":{schema},...(markdown?{"text/markdown":{schema:string}}:{})}},...errors});
const format = parameter("format",{enum:["json","markdown"],default:"json"},"Markdown separates saved original from generated summary.");
export const researchOpenApi = {
  openapi:"3.1.0",info:{title:"AIHOT private research API",version:"1.1.0",description:"Retained articles and online backfill materials only. No fetching, collection or model calls. Manual withdrawal is excluded; summary-only bodies cannot be searched or read. Completeness refers to stored evidence, not body length."},
  servers:[{url:"/api/private/v1"}],security:[{researchBearer:[]}],
  paths:{
    "/sources":{get:{operationId:"researchSources",parameters:[...paging,parameter("q",{...string,maxLength:256},"Name substring"),parameter("kind",{...string,maxLength:80},"Source kind")],responses:response(page(ref("Source"))) }},
    "/groups":{get:{operationId:"researchGroups",responses:response(page(ref("Group"))) }},
    "/articles":{get:{operationId:"researchArticles",parameters:[...paging,selectors("source","Exact source ID, name or explicit alias. Repeat to union sources. Ambiguity is an error with candidates; ID takes precedence."),selectors("group","Exact group ID or name. Repeat to union groups and sources; empty groups never broaden the query."),parameter("timeField",{enum:["effective","published","discovered","updated"],default:"effective"},"effective preserves published/discovered fallback filtering and fixed sortAt ordering. Explicit axes filter and order that field descending, then ID; published excludes missing dates. updated is projection update time, not CDC."),parameter("q",{...string,maxLength:256},"Up to six whitespace-separated literal terms, AND matched in title, generated summary or full saved text; case insensitive, Chinese supported."),parameter("from",{type:"string",format:"date-time"},"Inclusive selected time field, with explicit timezone offset"),parameter("to",{type:"string",format:"date-time"},"Exclusive selected time field, with explicit timezone offset"),parameter("selected",{enum:["true","false"]},"Current selected flag; absent publication means false")],responses:response({...page(ref("Summary")),properties:{...page(ref("Summary")).properties,query:{type:"object",required:Object.keys(queryProperties),properties:queryProperties}}}) }},
    "/articles/{id}":{get:{operationId:"researchRead",parameters:[{name:"id",in:"path",required:true,schema:{...string,maxLength:80},description:"Stable doc_ ID or native article ID"},format],responses:response(ref("Article"),true)}},
    "/articles/resolve":{get:{operationId:"researchResolve",parameters:[{...parameter("url",{...string,format:"uri",maxLength:4096},"Canonicalizes locally; never fetches the URL"),required:true},format],responses:response(ref("Article"),true)}},
    "/openapi.json":{get:{operationId:"researchSchema",responses:response({type:"object"})}},
  },
  components:{securitySchemes:{researchBearer:{type:"http",scheme:"bearer"}},schemas:{
    Error:{type:"object",required:["error"],properties:{error:{enum:["invalid_request","unknown_source","ambiguous_source","unknown_group","ambiguous_group","unauthorized","not_found","index_not_ready","busy","unavailable"]},selector:string,candidates:{type:"array",items:{type:"object",properties:{id:string,name:string},required:["id","name"]}}}},
    Group:{type:"object",required:["id","name","sourceIds"],properties:{id:string,name:string,sourceIds:{type:"array",items:string}}},
    Source:{type:"object",required:["id","name","kind"],properties:{
      id:string,name:string,kind:string,aliases:{type:"array",items:string},
      collection:{type:"object",description:"Stored collector observations, not a guarantee of upstream freshness. null times mean no recorded observation; failed/running counts are null. No raw errors or collector configuration.",properties:{
        enabled:{type:"boolean"},health:{enum:["ok","degraded","failing","paused","unknown"]},lastSuccessAt:date,lastFetchAt:date,nextFetchAt:date,
        latestRun:{type:["object","null"],properties:{startedAt:date,finishedAt:date,status:{enum:["running","ok","failed","skipped"]},foundCount:{type:["integer","null"]},newCount:{type:["integer","null"]}}},
      }},
    }},
    Summary:{type:"object",required:Object.keys(summaryProperties),properties:summaryProperties},
    Article:{type:"object",required:[...Object.keys(summaryProperties),"body","completeness","translations"],properties:{...summaryProperties,
      body:{type:["object","null"],properties:{text:nullableString,html:nullableString,truncated:{const:false}},required:["text","html","truncated"]},
      completeness:{type:"object",required:["state","evidence"],properties:{state:{enum:["complete","incomplete","unverified"]},evidence:nullableString}},
      translations:{type:"array",items:{type:"object",required:["lang","title","text","html","complete","origin"],properties:{lang:string,title:nullableString,text:nullableString,html:nullableString,complete:{type:"boolean"},origin:string}}},
    }},
  }},
};

// v1 is frozen. v2 reuses every route/auth/read rule and adds an independently verified reading URL.
const readingUrl = { ...nullableString, description:"Verified WeChat reading URL, or null. url remains the original collected address. Use readingUrl ?? url to read." };
export const researchOpenApiV2 = {
  ...researchOpenApi,
  info: { ...researchOpenApi.info, version:"2.0.0" }, servers:[{url:"/api/private/v2"}],
  components:{...researchOpenApi.components,schemas:{...researchOpenApi.components.schemas,
    Summary:{...researchOpenApi.components.schemas.Summary,
      required:[...researchOpenApi.components.schemas.Summary.required,"readingUrl"],
      properties:{...researchOpenApi.components.schemas.Summary.properties,readingUrl}},
    Article:{...researchOpenApi.components.schemas.Article,
      required:[...researchOpenApi.components.schemas.Article.required,"readingUrl"],
      properties:{...researchOpenApi.components.schemas.Article.properties,readingUrl}},
  }},
};

// v3 preserves v2 reads and adds explicit paid, worker-only semantic query submission.
const semanticQuerySchema = {type:"object",additionalProperties:false,required:["q"],properties:{
  q:{type:"string",minLength:1,maxLength:2000},source:{type:"array",items:{type:"string"},minItems:1,maxItems:100},group:{type:"array",items:{type:"string"},minItems:1,maxItems:100},
  timeField:{enum:["effective","published","discovered","updated"],default:"effective"},from:{type:"string",format:"date-time"},to:{type:"string",format:"date-time"},selected:{type:"boolean"},limit:{type:"integer",minimum:1,maximum:100,default:40},
}};
const embeddingIdentity = {type:"object",required:["model","dimensions","profile","provider"],properties:{model:string,dimensions:{type:"integer"},profile:{const:"title-summary-v1"},provider:string,gateway:{type:"object",required:["route","actualModel"],properties:{route:string,actualModel:string}}}};
const semanticTask = {type:"object",required:["id","requestId","createdAt","expiresAt","status","embedding","receipt"],properties:{
  id:{type:"string",format:"uuid"},requestId:{type:"string",format:"uuid"},createdAt:{type:"string",format:"date-time"},expiresAt:{type:"string",format:"date-time"},
  status:{enum:["queued","running","ready","failed","expired"]},reason:string,embedding:embeddingIdentity,
  receipt:{type:"object",required:["id","status","usage","cost"],properties:{id:{type:["integer","null"]},status:nullableString,usage:{type:["object","null"]},cost:{type:["object","null"],properties:{amount:{type:"number"},currency:string,basis:string}}}},
  result:{type:"object",required:["items","query","coverage","consistency","asOf","timingMs"],properties:{
    items:{type:"array",items:{allOf:[{$ref:"#/components/schemas/Summary"},{type:"object",required:["score"],properties:{score:{type:"number",description:"Cosine similarity, not a relevance probability."}}}]}},
    query:{type:"object"},coverage:{type:"object",required:["total","eligible","missing","stale","incompatible","policyExcluded"],properties:Object.fromEntries(["total","eligible","missing","stale","incompatible","policyExcluded"].map(k=>[k,{type:"integer",minimum:0}]))},
    consistency:{const:"live"},asOf:{type:"string",format:"date-time"},timingMs:{type:"number"},
  }},
}};
const semanticResponse = {description:"Short-lived owner-bound task. POST acknowledges identity; GET returns a live result. Unknown cost is null.",content:{"application/json":{schema:{$ref:"#/components/schemas/SemanticTask"}}}};
export const researchOpenApiV3 = {
  ...researchOpenApiV2,info:{...researchOpenApiV2.info,version:"3.0.0",description:"Private retained-material reads and explicit asynchronous semantic queries. Only semantic POST permits worker embedding calls; read routes never call models."},servers:[{url:"/api/private/v3"}],
  paths:{...researchOpenApiV2.paths,
    "/semantic-queries":{post:{summary:"Submit or resume one query embedding",description:"Requires read and explicit semantic capability. Preserve the entire request envelope. Same owner/requestId with different payload conflicts within retention. createdAt expires after 24 hours, even after task deletion. Future skew at most 60 seconds. Stored-vector profile must be operator verified; no article backfill.",requestBody:{required:true,content:{"application/json":{schema:{type:"object",additionalProperties:false,required:["requestId","createdAt","query"],properties:{requestId:{type:"string",format:"uuid"},createdAt:{type:"string",format:"date-time"},query:semanticQuerySchema}}}}},responses:{"200":semanticResponse,"202":semanticResponse,"400":{description:"Invalid envelope"},"401":{description:"Read identity revoked"},"403":{description:"Semantic capability unavailable/revoked"},"409":{description:"Request identity conflict or profile changed"},"410":{description:"Request expired"},"503":{description:"Profile unverified or capacity unavailable"}}}},
    "/semantic-queries/{id}":{get:{summary:"Poll and rank against current retained materials",description:"Requires the original owner token and current read/semantic capability. Applies current article revisions and restrictions. No vector, owner digest, provider error or secret is returned.",parameters:[{name:"id",in:"path",required:true,schema:{type:"string",format:"uuid"}}],responses:{"200":semanticResponse,"401":{description:"Read identity revoked"},"403":{description:"Semantic capability revoked"},"404":{description:"Unknown or other owner task"},"409":{description:"Profile changed"},"410":semanticResponse,"503":{description:"Index, profile or read capacity unavailable"}}}},
  },components:{...researchOpenApiV2.components,schemas:{...researchOpenApiV2.components.schemas,SemanticTask:semanticTask}},
};
