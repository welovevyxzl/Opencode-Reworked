const ts = require("D:/Projects/Opencode-Reworked/node_modules/typescript");
const path = require("path");
const root = "D:/Projects/Opencode-Reworked";
const configPath = path.join(root, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) { console.log("config error:", config.error); process.exit(1); }
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const emitResult = program.emit();
const diags = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
console.log("files checked:", parsed.fileNames.length);
console.log("errors:", diags.length);
let n = 0;
for (const d of diags) {
  if (n > 40) { console.log("...and more"); break; }
  n++;
  const f = d.file ? d.file.fileName.replace(root, "") : "(global)";
  const pos = d.file ? d.file.getLineAndCharacterOfPosition(d.start || 0) : {};
  console.log(`  ${f}:${(pos.line + 1) || "?"} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}
