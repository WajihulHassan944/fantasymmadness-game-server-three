'use strict';
// End-to-end isolated SMTP receipt verification using a loopback-only mail sink.
const assert=require('node:assert/strict');
const net=require('node:net');
const nodemailer=require('nodemailer');
const {createSandboxMailSender}=require('./growth-approved-sandbox-mail');
async function run(){
 const captured=[];
 const server=net.createServer(socket=>{
  socket.setEncoding('utf8');
  socket.write('220 localhost isolated ESMTP\r\n');
  let buffer='',data=false,message='';
  socket.on('data',chunk=>{
   buffer+=chunk;
   let pos;
   while((pos=buffer.indexOf('\n'))!==-1){
    const line=buffer.slice(0,pos+1).trim();buffer=buffer.slice(pos+1);
    if(data){
     if(line==='.') {data=false;captured.push(message);message='';socket.write('250 accepted\r\n');}
     else message+=line+'\n';
    }else if(/^(EHLO|HELO)/i.test(line))socket.write('250-localhost\r\n250 OK\r\n');
    else if(/^MAIL FROM:/i.test(line))socket.write('250 OK\r\n');
    else if(/^RCPT TO:/i.test(line)){assert.match(line,/sandbox-recipient@localhost/i);socket.write('250 OK\r\n');}
    else if(line==='DATA'){data=true;socket.write('354 Enter message\r\n');}
    else if(line==='QUIT')socket.end('221 Bye\r\n');
    else socket.write('250 OK\r\n');
   }
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 try{
  const transport=nodemailer.createTransport({host:'127.0.0.1',port:server.address().port,secure:false,ignoreTLS:true});
  const send=createSandboxMailSender({transport});
  const draft={id:'sandbox-campaign-1',recipient:'sandbox-recipient@localhost',subject:'FANTASY MMADNESS sandbox',text:'Approved synthetic campaign',status:'approved',ownerApproved:true,sendPermitted:true};
  const receipt=await send({draft,approval:{draftId:draft.id,ownerApproved:true}});
  assert.equal(receipt.ok,true);assert.equal(receipt.receipt.sandbox,true);assert.equal(receipt.receipt.realDelivery,false);
  assert.equal(captured.length,1);assert.match(captured[0],/FANTASY MMADNESS/);
  const blocked=await send({draft:{...draft,recipient:'real@example.org'},approval:{draftId:draft.id,ownerApproved:true}});
  assert.equal(blocked.ok,false);assert.equal(captured.length,1);
  console.log('PASS approved sandbox SMTP delivery receipt; external messages 0; production writes 0');
 }finally{await new Promise(resolve=>server.close(resolve));}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
