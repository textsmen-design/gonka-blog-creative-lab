// tools/admin/lib/image-check.mjs — проверка и очистка загружаемых изображений (PNG, JPEG, WebP) без внешних зависимостей.
// Проверяется СОДЕРЖИМОЕ (сигнатуры и структура), а не имя или заявленный тип. SVG/HTML/любые другие форматы отклоняются.
// Очистка: JPEG — убираются EXIF/XMP/IPTC/комментарии (геометки!), хвост после EOI; PNG — хвост после IEND; WebP — EXIF/XMP и хвост.
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_SIDE = 8000, MIN_SIDE = 16, MAX_PIXELS = 40_000_000;
export const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const bad = (error) => ({ ok: false, error });

function checkPng(buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 33 || !SIG.every((b, i) => buf[i] === b)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR' || buf.readUInt32BE(8) !== 13) return bad('повреждённый PNG: нет заголовка IHDR');
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  let p = 8, end = -1, sawIdat = false;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (len > buf.length) return bad('повреждённый PNG: неверная длина блока');
    if (type === 'IDAT') sawIdat = true;
    p += 12 + len;
    if (type === 'IEND') { end = p; break; }
  }
  if (end === -1 || !sawIdat) return bad('повреждённый PNG: нет данных изображения или IEND');
  return { ok: true, ext: 'png', mime: 'image/png', width, height, data: buf.subarray(0, end) };   // хвост после IEND отбрасывается
}

function checkJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  const out = [buf.subarray(0, 2)];
  let p = 2, width = 0, height = 0, sos = -1;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return bad('повреждённый JPEG: нарушена структура сегментов');
    let m = buf[p + 1];
    while (m === 0xff && p + 2 < buf.length) { p++; m = buf[p + 1]; }                 // заполняющие 0xFF
    if (m === 0xd9) break;                                                            // EOI до данных
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) return bad('повреждённый JPEG: неверная длина сегмента');
    const seg = buf.subarray(p, p + 2 + len);
    const sof = (m >= 0xc0 && m <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(m);
    if (sof) { height = buf.readUInt16BE(p + 5); width = buf.readUInt16BE(p + 7); }
    const drop = m === 0xe1 || m === 0xed || m === 0xfe || (m >= 0xe3 && m <= 0xec && m !== 0xee) || m === 0xef;   // EXIF/XMP, IPTC, комментарии, прочие APPn (оставляем APP0 JFIF, APP2 ICC, APP14 Adobe)
    if (!drop) out.push(seg);
    p += 2 + len;
    if (m === 0xda) { sos = p; break; }
  }
  if (sos === -1 || !width || !height) return bad('повреждённый JPEG: нет данных изображения');
  let eoi = -1;
  for (let i = buf.length - 2; i >= sos; i--) if (buf[i] === 0xff && buf[i + 1] === 0xd9) { eoi = i + 2; break; }
  if (eoi === -1) return bad('повреждённый JPEG: нет конца файла (EOI)');
  out.push(buf.subarray(sos, eoi));                                                   // хвост после EOI отбрасывается
  return { ok: true, ext: 'jpg', mime: 'image/jpeg', width, height, data: Buffer.concat(out) };
}

function checkWebp(buf) {
  if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const riffEnd = 8 + buf.readUInt32LE(4);
  if (riffEnd > buf.length || riffEnd < 20) return bad('повреждённый WebP: неверный размер RIFF');
  let p = 12, width = 0, height = 0, vp8x = -1, hasImage = false;
  const keep = [];
  while (p + 8 <= riffEnd) {
    const type = buf.toString('latin1', p, p + 4), len = buf.readUInt32LE(p + 4), padded = len + (len & 1);
    if (p + 8 + padded > riffEnd + 1 && p + 8 + len > riffEnd) return bad('повреждённый WebP: блок выходит за пределы файла');
    const chunk = buf.subarray(p, Math.min(p + 8 + padded, riffEnd));
    if (type === 'VP8X') { vp8x = keep.length; width = 1 + buf.readUIntLE(p + 12, 3); height = 1 + buf.readUIntLE(p + 15, 3); keep.push(Buffer.from(chunk)); }
    else if (type === 'VP8 ') { hasImage = true; if (!width) { width = buf.readUInt16LE(p + 14) & 0x3fff; height = buf.readUInt16LE(p + 16) & 0x3fff; } keep.push(chunk); }
    else if (type === 'VP8L') { hasImage = true; if (!width) { const b = buf.readUInt32LE(p + 9); width = (b & 0x3fff) + 1; height = ((b >> 14) & 0x3fff) + 1; } keep.push(chunk); }
    else if (type === 'EXIF' || type === 'XMP ') { /* метаданные удаляются */ }
    else keep.push(chunk);
    p += 8 + padded;
  }
  if (!hasImage && !keep.some((c) => c.toString('latin1', 0, 4) === 'ANMF')) return bad('повреждённый WebP: нет данных изображения');
  if (vp8x !== -1) keep[vp8x][8] &= ~(0x08 | 0x04);                                   // сбрасываем флаги EXIF и XMP
  const body = Buffer.concat(keep);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + body.length, 4); head.write('WEBP', 8, 'latin1');
  return { ok: true, ext: 'webp', mime: 'image/webp', width, height, data: Buffer.concat([head, body]) };
}

export function inspectImage(buf, declaredMime) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return bad('пустой файл');
  if (buf.length > MAX_BYTES) return bad(`файл больше 2 МБ (${buf.length} байт)`);
  const r = checkPng(buf) || checkJpeg(buf) || checkWebp(buf);
  if (!r) return bad('допустимы только PNG, JPEG и WebP (SVG, GIF, HTML и прочее запрещены); содержимое файла не похоже на изображение');
  if (r.ok === false) return r;
  if (declaredMime && MIME_EXT[declaredMime] && MIME_EXT[declaredMime] !== r.ext) return bad(`заявленный тип ${declaredMime} не совпадает с содержимым (${r.mime})`);
  if (declaredMime && !MIME_EXT[declaredMime]) return bad('допустимые типы: image/png, image/jpeg, image/webp');
  if (r.width < MIN_SIDE || r.height < MIN_SIDE) return bad(`изображение слишком маленькое (${r.width}×${r.height}, минимум ${MIN_SIDE}×${MIN_SIDE})`);
  if (r.width > MAX_SIDE || r.height > MAX_SIDE || r.width * r.height > MAX_PIXELS) return bad(`изображение слишком большое (${r.width}×${r.height})`);
  return r;
}
