const fs = require("fs");
const st = d => {
  try { return fs.statSync("D:/Projects/Opencode-Reworked/" + d).mtime.toISOString(); }
  catch (e) { return "N/A"; }
};
console.log("src use.ts    :", st("src/commands/use.ts"));
console.log("src code.ts   :", st("src/commands/code.ts"));
console.log("src opencode.ts:", st("src/commands/opencode.ts"));
console.log("dist use.js   :", st("dist/commands/use.js"));
console.log("dist code.js  :", st("dist/commands/code.js"));
console.log("dist opencode.js:", st("dist/commands/opencode.js"));

const has = (f, s) => {
  const p = "D:/Projects/Opencode-Reworked/" + f;
  if (!fs.existsSync(p)) return f + ": NO FILE";
  return f + ": " + (fs.readFileSync(p, "utf8").includes(s) ? "HAS FIX" : "NO FIX");
};
console.log(has("dist/commands/use.js", "parentId ?? channel.id"));
console.log(has("dist/commands/code.js", "getChannelBinding(parentId) || getChannelBinding(channel.id)"));
console.log(has("dist/commands/opencode.js", "getChannelBinding(channel.id) : null"));
