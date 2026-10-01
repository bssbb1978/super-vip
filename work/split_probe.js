const fs=require('fs'),path=require('path'),acorn=require('acorn');
const dir='/home/user/work/units';
const SAFE=new Set(['FunctionDeclaration','ClassDeclaration','VariableDeclaration','EmptyStatement']);
for (const f of fs.readdirSync(dir).filter(x=>/^u\d+\.js$/.test(x)).sort()){
  const src=fs.readFileSync(path.join(dir,f),'utf8');
  const ast=acorn.parse(src,{ecmaVersion:2022,sourceType:'module',allowAwaitOutsideFunction:true,allowReturnOutsideFunction:true});
  const eff=[];
  for(const n of ast.body){
    if (SAFE.has(n.type)) continue;
    const text=src.slice(n.start,n.end);
    eff.push({t:n.type,line:src.slice(0,n.start).split('\n').length,snip:text.slice(0,80).replace(/\n/g,' ')});
  }
  const tla = ast.body.some(n=>/(^|[^.\w])await[\s(]/.test(src.slice(n.start,n.end)) && !SAFE.has(n.type));
  console.log(`${f}: top-level statements=${ast.body.length} deferred=${eff.length} topLevelAwait=${tla}`);
  eff.slice(0,6).forEach(e=>console.log(`      L${e.line} ${e.t} :: ${e.snip}`));
}
