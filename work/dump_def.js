const fs=require('fs'),acorn=require('acorn');
const src=fs.readFileSync('/home/user/work/units/u00.js','utf8');
const ast=acorn.parse(src,{ecmaVersion:2022,sourceType:'module',allowAwaitOutsideFunction:true,allowReturnOutsideFunction:true});
const SAFE=new Set(['FunctionDeclaration','ClassDeclaration','VariableDeclaration','EmptyStatement']);
const eff=[];
for(const n of ast.body){
  const isDirective=n.type==='ExpressionStatement'&&n.expression.type==='Literal'&&typeof n.expression.value==='string';
  if(SAFE.has(n.type)||isDirective)continue;
  const line=src.slice(0,n.start).split('\n').length;
  eff.push(`L${line} ${n.type} :: ${src.slice(n.start,Math.min(n.end,n.start+110)).replace(/\n/g,' ')}`);
}
console.log(eff.join('\n'));
