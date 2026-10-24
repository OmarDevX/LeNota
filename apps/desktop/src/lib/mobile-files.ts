/** Android document-provider URLs often omit extensions. Detect common files
 * from their headers so images/PDFs retain their type after import. */
export function mobileFileType(bytes: Uint8Array): { mime: string; extension: string } {
  const starts = (...signature: number[]) => signature.every((value,index) => bytes[index] === value);
  const ascii = (offset: number, value: string) => Array.from(value).every((char,index) => bytes[offset+index] === char.charCodeAt(0));
  if (starts(137,80,78,71,13,10,26,10)) return {mime:"image/png",extension:"png"};
  if (starts(255,216,255)) return {mime:"image/jpeg",extension:"jpg"};
  if (ascii(0,"GIF87a") || ascii(0,"GIF89a")) return {mime:"image/gif",extension:"gif"};
  if (ascii(0,"RIFF") && ascii(8,"WEBP")) return {mime:"image/webp",extension:"webp"};
  if (ascii(0,"%PDF-")) return {mime:"application/pdf",extension:"pdf"};
  if (ascii(0,"RIFF") && ascii(8,"WAVE")) return {mime:"audio/wav",extension:"wav"};
  if (ascii(0,"ID3")) return {mime:"audio/mpeg",extension:"mp3"};
  return {mime:"application/octet-stream",extension:"bin"};
}
