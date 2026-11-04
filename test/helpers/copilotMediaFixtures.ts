import fs from 'fs';
import path from 'path';

// A tiny PNG keeps skipped native suites independent of native canvas workers.
export const copilotPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==', 'base64');

export function copilotPdf(): Buffer {
  const content = 'BT /F1 18 Tf 36 120 Td (COPILOT_MEDIA_PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  return Buffer.from(`${pdf}xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

export function writeCopilotMediaTool(dir: string): string {
  const tool = path.join(dir, 'media-fixture.cjs');
  fs.writeFileSync(tool, `
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); if(request.id===undefined)return;
 let result;
 if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'media-fixture',version:'1'}};
 else if(request.method==='tools/list')result={tools:[{name:'media_output',description:'Return synthetic image and PDF bytes',inputSchema:{type:'object',properties:{}}}]};
 else if(request.method==='tools/call')result={content:[{type:'image',mimeType:'image/png',data:${JSON.stringify(copilotPng.toString('base64'))}},{type:'resource',resource:{uri:'fixture:///report.pdf',mimeType:'application/pdf',blob:${JSON.stringify(copilotPdf().toString('base64'))}}}]};
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\\n');return;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
`);
  return tool;
}
