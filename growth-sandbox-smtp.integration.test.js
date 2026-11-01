'use strict';
// Isolated SMTP delivery smoke test. A loopback-only SMTP sink accepts one
// branded message. No external mail, production DB, or production credentials.
const assert=require('node:assert/strict');
const net=require('node:net');
const nodemailer=require('nodemailer');
const {renderBusinessEmail}=require('./growth-business-email-templates');
const {stagingPreflight}=require('./growth-staging-preflight');
async function run(){
 const gate=stagingPreflight({GROWTH_STAGING_MODE:'isolated',GROWTH_STAGING_DB_ATTESTED:'true',GROWTH_STAGING_MAIL_SANDBOX_ATTESTED:'true',GROWTH_OUTBOUND_ENABLED:'false'});
 assert.equal(gate.ready,true);
 assert.equal(gate.realDeliveryPermitted,false);
 let received='',recipients=0;
 const server=net.createServer(socket=>{
  socket.setEncoding('utf8');socket.write('220 localhost sandbox ESMTP\r\n');
  let data=false,buffer='';
  socket.on('data',chunk=>{
   buffer+=chunk;
   let pos;
   while((pos=buffer.indexOf('\n'))!==-1){
    const raw=buffer.slice(0,pos+1);buffer=buffer.slice(pos+1);
    const line=raw.trim();
    if(data){if(line==='.') {data=false;socket.write('250 sandbox accepted\r\n');}else received+=raw;continue;}
    if(/^EHLO|^HELO/i.test(line))socket.write('250-localhost\r\n250 OK\r\n');
    else if(/^MAIL FROM:/i.test(line))socket.write('250 OK\r\n');
    else if(/^RCPT TO:/i.test(line)){assert.match(line,/sandbox-recipient@localhost/i);recipients++;socket.write('250 OK\r\n');}
    else if(/^DATA$/i.test(line)){data=true;socket.write('354 End data with <CRLF>.<CRLF>\r\n');}
    else if(/^QUIT$/i.test(line))socket.end('221 Bye\r\n');
    else socket.write('250 OK\r\n');
   }
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  const {html,text,subject}=renderBusinessEmail({type:'affiliate',recipientName:'Sandbox Tester',personalization:'Test-only campaign.'});
  const transport=nodemailer.createTransport({host:'127.0.0.1',port:server.address().port,secure:false,ignoreTLS:true});
  await transport.sendMail({from:'contact@fantasymmadnesscom.com',to:'sandbox-recipient@localhost',subject,text,html});
  assert.equal(recipients,1);
  assert.match(received,/FANTASY MMADNESS/);
  assert.match(received,/sandbox-recipient@localhost/);
  console.log('PASS sandbox SMTP loopback: branded draft delivered to local sink; external recipients 0; production writes 0');
 }finally{await new Promise(resolve=>server.close(resolve));}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
