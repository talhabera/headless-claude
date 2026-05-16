// src/stages/parse.js
export function parseResultBlock(text) {
  const m = text.match(/<<<RESULT\s*([\s\S]*?)\s*RESULT>>>/);
  if (!m) throw new Error("no RESULT block in stage output");
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`invalid RESULT json: ${e.message}`);
  }
}
