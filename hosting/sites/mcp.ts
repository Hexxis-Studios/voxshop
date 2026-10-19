import { z } from 'zod';
import { context, route, failure } from './api';
import { HttpError } from './store';
import type { Bindings } from './store';
import { idSchema, transactionSchema } from '../../services/projectDocument';
import { recipeSchema } from '../../services/recipeGenerator';
import { playtestSchema } from '../../runtime/playtest';

const fields={projectId:idSchema};
const revision={expectedRevision:z.number().int().nonnegative(),requestId:idSchema};
const definitions = [
  ['project_list','List saved projects and the active project.',z.object({}),true],
  ['project_create','Create and activate a saved project with a stable new ID.',z.object({name:z.string().min(1).max(120),id:idSchema}),false],
  ['project_inspect','Read project metadata. Request full=true only when complete portable data is needed.',z.object({...fields,full:z.boolean().default(false)}),true],
  ['project_activate','Open a saved project in the editor without changing its revision.',z.object(fields),false],
  ['project_apply','Apply an atomic undoable batch. Inspect project_commands for the operation schema first.',z.object({...fields,...revision,operations:z.array(z.record(z.string(),z.unknown())).min(1).max(1024)}),false],
  ['project_undo','Undo one complete transaction. Revision increases.',z.object({...fields,...revision}),false],
  ['project_redo','Redo one complete transaction. Revision increases.',z.object({...fields,...revision}),false],
  ['project_save','Save a portable snapshot and return its private download route. Edits are already saved.',z.object(fields),false],
  ['asset_generate','Generate an editable asset from deterministic composable solids, returning a job.',z.object({...fields,...revision,id:idSchema,name:z.string().min(1).max(120),recipe:recipeSchema,voxelSize:z.number().positive().max(100).default(0.1)}),false],
  ['asset_preview','Read an asset as an isometric SVG document.',z.object({...fields,assetId:idSchema}),true],
  ['example_create','Create an editable exploration or arena game, including all original assets and rules.',z.object({kind:z.enum(['exploration','arena']),id:idSchema}),false],
  ['project_playtest','Run bounded input steps and assertions against a scene; return a durable job.',z.object({...fields,spec:playtestSchema}),false],
  ['scene_build','Build a playable standalone HTML game with no runtime network dependencies.',z.object({...fields,sceneId:idSchema}),false],
  ['job_status','Inspect a stored generation, playtest or game-build result.',z.object({jobId:idSchema}),true],
  ['job_cancel','Cancel when supported; already completed jobs remain completed.',z.object({jobId:idSchema}),false],
  ['project_import','Import a portable project using a new stable ID.',z.object({id:idSchema,project:z.record(z.string(),z.unknown())}),false],
  ['project_commands','Read the complete validated transaction schema before composing engine operations.',z.object({}),true],
] as const;

export async function mcp(request:Request,env:Partial<Bindings>) {
  let id:unknown=null;
  try {
    context(request,env);
    const origin=request.headers.get('origin');
    if((origin&&origin!==new URL(request.url).origin)||request.headers.get('sec-fetch-site')==='cross-site')
      throw new HttpError(403,'Cross-site MCP requests are not allowed.');
    const message=await request.json() as {id?:unknown;method?:string;params?:{name?:string;arguments?:unknown;protocolVersion?:string}};
    id=message.id ?? null;
    let result:unknown;
    if(message.method==='server/discover')result={supportedVersions:['2026-07-28'],capabilities:{tools:{}},serverInfo:{name:'voxshop',version:'0.1.0'}};
    else if(message.method==='initialize')result={protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'voxshop',version:'0.1.0'},instructions:'Inspect before editing. Mutations require expectedRevision and a unique requestId. Call project_commands for operation schemas. Assets use meters, Y up and radians. All writes are saved, revision checked and undoable. Use jobs to read playtests and builds.'};
    else if(message.method==='notifications/initialized')return new Response(null,{status:202});
    else if(message.method==='ping')result={};
    else if(message.method==='tools/list')result={tools:definitions.map(([name,description,schema,readOnly])=>({name,description,inputSchema:z.toJSONSchema(schema),annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:false,idempotentHint:readOnly}}))};
    else if(message.method==='tools/call'){
      try {
        const name=message.params?.name,definition=definitions.find(d=>d[0]===name);
        if(!definition)throw Error('Unknown VoxShop tool.');
        const a=definition[2].parse(message.params?.arguments ?? {}) as any;
        const base=new URL(request.url).origin;
        const api=async(path:string,body?:unknown)=>{
          const response=await route(new Request(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':request.headers.get('oai-authenticated-user-id')!},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,true);
          if(!response.ok){const error=await response.json() as {error:string};throw Error(error.error);}
          return response;
        };
        let value:any;
        if(name==='project_commands')value=z.toJSONSchema(transactionSchema,{io:'input'});
        else if(name==='asset_preview')value={format:'image/svg+xml',svg:await(await api(`/projects/${a.projectId}/assets/${a.assetId}/preview`)).text()};
        else {
          let path='',body:unknown=undefined;
          if(name==='project_list')path='/projects';
          else if(name==='project_create'){path='/projects';body=a;}
          else if(name==='project_import'){path='/projects/import';body=a;}
          else if(name==='example_create'){path='/examples';body=a;}
          else if(name==='project_inspect')path=`/projects/${a.projectId}${a.full?'':'/summary'}`;
          else if(name==='job_status')path=`/jobs/${a.jobId}`;
          else if(name==='job_cancel'){path=`/jobs/${a.jobId}/cancel`;body={};}
          else if(name==='asset_generate'){
            path=`/projects/${a.projectId}/generate`;body={expectedRevision:a.expectedRevision,requestId:a.requestId,operations:[{type:'asset.generate',id:a.id,name:a.name,recipe:a.recipe,voxelSize:a.voxelSize}]};
          }else{
            const action:Record<string,string>={project_apply:'transactions',project_undo:'undo',project_redo:'redo',project_activate:'activate',project_save:'save',project_playtest:'playtest',scene_build:'build'};
            path=`/projects/${a.projectId}/${action[name!]}`;
            const {projectId,...rest}=a;body=name==='project_playtest'?a.spec:rest;
          }
          value=await(await api(path,body)).json();
          if(value.project?.assets)value={projectId:value.project.id,name:value.project.name,revision:value.project.revision,appliedRevision:value.appliedRevision,replayed:value.replayed};
          else if(value.assets&&value.scenes&&!a.full)value={projectId:value.id,name:value.name,revision:value.revision,assets:value.assets.length,scenes:value.scenes.length};
        }
        result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
      }catch(error){result={isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Tool failed.'}]};}
    }else return Response.json({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found.'}},{status:200});
    return Response.json({jsonrpc:'2.0',id,result},{headers:{'Cache-Control':'no-store'}});
  }catch(error){return failure(error);}
}
