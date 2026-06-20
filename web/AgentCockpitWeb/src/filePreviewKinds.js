const TEXT_EXTS = new Set(['txt','md','markdown','json','yaml','yml','xml','csv','tsv','log','ini','conf','env','html','htm','css','js','ts','tsx','jsx','astro','py','sh','bash','zsh','go','rs','java','c','cpp','h','hpp','sql','toml','rb','php','swift','kt','scala','r','lua','pl','gitignore','gitattributes','dockerignore','editorconfig']);
const MD_EXTS = new Set(['md','markdown']);
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico']);
const IMAGE_PREVIEW_LIMIT = 25 * 1024 * 1024;

export function extOf(name){
  const i = (name || '').lastIndexOf('.');
  if (i < 0) return (name || '').toLowerCase().replace(/^\./, '');
  return (name || '').slice(i + 1).toLowerCase();
}

export function previewKind(name, size){
  const e = extOf(name);
  if (IMAGE_EXTS.has(e)) return (size || 0) > IMAGE_PREVIEW_LIMIT ? 'oversize-image' : 'image';
  if (MD_EXTS.has(e)) return 'markdown';
  if (TEXT_EXTS.has(e)) return 'text';
  return 'unsupported';
}
