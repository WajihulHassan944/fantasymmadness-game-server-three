const fs=require('node:fs'),path=require('node:path');
fs.mkdirSync(path.join(__dirname,'shared'),{recursive:true});
for(const f of fs.readdirSync(path.join(__dirname,'..')))if(/^growth-.*\.js$/.test(f)&&!/(\.test\.|browser|preview|routes|console)/.test(f))fs.copyFileSync(path.join(__dirname,'..',f),path.join(__dirname,'shared',f));
fs.copyFileSync(path.join(__dirname,'..','fight-entry-time.js'),path.join(__dirname,'shared','fight-entry-time.js'));

fs.writeFileSync(path.join(__dirname,'shared','package.json'),JSON.stringify({type:'commonjs'}));
