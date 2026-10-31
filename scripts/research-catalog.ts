// Trusted operator CLI. The research HTTP bearer remains read-only.
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { listGroups, resolveSources, setAlias, setGroup, ResearchInputError } from "@aihot/backend/research/catalog";

try {
  const {values,positionals} = parseArgs({allowPositionals:true,options:{
    id:{type:"string"},name:{type:"string"},source:{type:"string",multiple:true},alias:{type:"string"},help:{type:"boolean"},
  }});
  if (values.help) console.log("research-catalog.ts list | set-group --id ID --name NAME [--source ID_OR_NAME ...] | delete-group --id ID | set-alias --source ID --alias NAME | delete-alias --source ID --alias NAME\nstdout: JSON; stderr: result. Requires DATABASE_URL operator access; no collection or model calls.");
  else {
    const command = positionals[0];
    if (positionals.length!==1 || !["list","set-group","delete-group","set-alias","delete-alias"].includes(command ?? "")) throw new ResearchInputError("invalid_command");
    const result = await sql.begin(async db=>{
      if (command==="set-group") {
        if (!values.id || !values.name) throw new ResearchInputError("id_and_name_required");
        await setGroup(db,values.id,values.name,values.source ?? []);
      } else if (command==="delete-group") {
        if (!values.id) throw new ResearchInputError("id_required");
        const rows=await db`DELETE FROM research_groups WHERE id=${values.id} RETURNING id`;
        if (!rows.length) throw new ResearchInputError("unknown_group");
      } else if (command==="set-alias" || command==="delete-alias") {
        if (values.source?.length!==1 || !values.alias) throw new ResearchInputError("one_source_and_alias_required");
        if (command==="set-alias") await setAlias(db,values.source[0]!,values.alias);
        else {
          const ids=await resolveSources(db,values.source);
          const rows=await db`DELETE FROM research_source_aliases WHERE source_id=${ids![0]!} AND alias=${values.alias} RETURNING alias`;
          if (!rows.length) throw new ResearchInputError("unknown_alias");
        }
      }
      return {groups:(await listGroups(db)).items,aliases:await db`SELECT source_id AS "sourceId",alias FROM research_source_aliases ORDER BY source_id,alias`};
    });
    console.log(JSON.stringify(result,null,2));
    console.error(command==="list" ? "已读取研究分组和别名配置。" : "研究目录变更已保存；采集配置与文章内容未修改。");
  }
} catch (error) {
  console.error(error instanceof ResearchInputError ? JSON.stringify({error:error.message,selector:error.selector,candidates:error.candidates}) : "研究目录操作失败；事务未提交，请检查数据库连接与迁移状态。");
  process.exitCode=1;
} finally { await closeDb(); }
