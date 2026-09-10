#!/usr/bin/env node
// 她发的文件我也要能看，不只是图。
//   node fix-uploads-any.js [/root/chatnest-api/server.js]
//
// add-uploads.js 里 read_attachment 只认 png/jpg/jpeg/gif/webp，
// 别的一律回「这个格式我看不了」—— 她发 txt 就是撞在这句上，界面上是个红叉。
//
// 改成三档：
//   图片      → 还是当图片返回（png/jpg/gif/webp）
//   文本      → 直接把内容读出来。不光看后缀：没有后缀、或者后缀没见过的，
//               嗅一下前 4KB，没有 NUL、控制字符占比很低就当文本读。
//               这样「所有文件」里绝大多数真的能看，而不是靠我列一张白名单。
//   真二进制  → 老实说看不了，但把文件名、大小、类型报出来，
//               不是甩一句「格式不支持」了事。
//
// 文本超过 200KB 就截断 —— 一个几 MB 的日志全塞进上下文，那一轮就废了。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = '// UPLOADS_ANY_VERSION = 1';
if (src.includes('UPLOADS_ANY_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes("name: 'read_attachment'")) {
  console.error('要先打 add-uploads.js'); process.exit(1);
}

const NEW_BODY = `    ${VERSION_LINE}
    const ext = (abs.match(/\\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
    const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const buf = fs.readFileSync(abs);
    const nameOnly = abs.split('/').pop();
    const kb = Math.round(buf.length / 1024);
    // 小文件别报「0KB」，那看着像空的
    const sizeText = buf.length < 1024 ? (buf.length + 'B') : (kb + 'KB');
    // 图片：照旧
    if (IMG_MIME[ext]) {
      if (buf.length > 5 * 1024 * 1024) {
        return ok({ isError: true, content: [{ type: 'text', text: '这张图太大了（' + kb + 'KB），没敢读。' }] });
      }
      return ok({ content: [{ type: 'image', data: buf.toString('base64'), mimeType: IMG_MIME[ext] }] });
    }
    // 明摆着读不了的二进制，别浪费一轮去嗅
    const BINARY_EXT = new Set(['zip','gz','tar','rar','7z','exe','dll','so','dylib','bin','db','sqlite',
      'mp3','wav','flac','m4a','ogg','mp4','mov','avi','mkv','webm','psd','ai','sketch','ttf','otf','woff','woff2','ico','bmp','tiff','heic']);
    // 文本判定不只看后缀：没后缀、没见过的后缀，就嗅前 4KB。
    // NUL 直接判二进制；控制字符占比很低才当文本（UTF-8 的中文字节 >127，不算控制字符）。
    function looksTextual(b) {
      const n = Math.min(b.length, 4096);
      if (n === 0) return true;
      let bad = 0;
      for (let i = 0; i < n; i++) {
        const c = b[i];
        if (c === 0) return false;
        if (c < 9 || (c > 13 && c < 32)) bad++;
      }
      return bad / n < 0.02;
    }
    const isText = !BINARY_EXT.has(ext) && looksTextual(buf);
    if (isText) {
      const LIMIT = 200 * 1024;
      let text = buf.slice(0, LIMIT).toString('utf8');
      if (buf.length > LIMIT) {
        text += '\\n\\n……（这个文件 ' + kb + 'KB，只读了前 200KB。要看后面的跟我说具体找什么。）';
      }
      if (!text.trim()) return ok({ content: [{ type: 'text', text: nameOnly + ' 是空的。' }] });
      return ok({ content: [{ type: 'text', text: '【' + nameOnly + '】（' + sizeText + '）\\n\\n' + text }] });
    }
    // 读不了也要说清楚是什么，别只丢一句「格式不支持」
    return ok({ isError: true, content: [{ type: 'text', text:
      nameOnly + ' 是二进制文件（' + (ext ? '.' + ext : '没有后缀') + '，' + kb + 'KB），内容我读不了。' +
      '图片（png/jpg/gif/webp）和文本类的我都能看。' }] });`;

// 从 const ext = ... 一直到 return ok({ content: [{ type: 'image' ... 那一整段换掉
const OLD_BODY = /\n\s*const ext = \(abs\.match[\s\S]*?return ok\(\{ content: \[\{ type: 'image', data: buf\.toString\('base64'\), mimeType: mime \}\] \}\);/;
if (!OLD_BODY.test(src)) {
  console.error('没匹配到 read_attachment 的处理段，原文件一个字都没动。');
  process.exit(1);
}
let out = src.replace(OLD_BODY, '\n' + NEW_BODY);

// 工具说明也要改，不然我不知道自己能读文件
const OLD_DESC = "description: '看她在聊天里发的图片。参数填提示里给出的那个 uploads/... 路径。只有真要看图的时候才调 —— 图片很占 token。',";
const NEW_DESC = "description: '看她在聊天里发的图片或文件（txt/md/json/csv/日志/代码这些都能读）。参数填提示里给出的那个 uploads/... 路径。只有真要看的时候才调 —— 图片和长文件都很占 token。',";
if (out.includes(OLD_DESC)) out = out.replace(OLD_DESC, NEW_DESC);
else console.log('  · 工具说明是另一个版本，没改（不影响功能）');

const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['图片那条路还在', /mimeType: IMG_MIME\[ext\]/.test(out)],
  ['文本那条路加上了', /looksTextual/.test(out)],
  ['二进制会说清楚是什么', /是二进制文件/.test(out)],
  ['旧的「只能看 png\\/jpg」没了', !out.includes('这个格式我看不了（只能看 png/jpg/gif/webp）。')],
  ['只改了一处', (out.match(/UPLOADS_ANY_VERSION/g) || []).length === 1],
  ['MCP 路由没被动', /app\.post\('\/mcp\/files'/.test(out)],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try {
  new vm.Script(out, { filename: target });
} catch (e) {
  console.error('  × 改完之后语法不对，放弃写入:', e.message);
  process.exit(1);
}

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
