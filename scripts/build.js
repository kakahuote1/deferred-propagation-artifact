const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
  console.error("tsconfig.json not found");
  process.exit(1);
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, process.cwd());
const program = ts.createProgram(parsed.fileNames, {
  ...parsed.options,
  noEmitOnError: false
});

const result = program.emit();
const diagnostics = ts.getPreEmitDiagnostics(program);
const errors = diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);

fs.mkdirSync(path.resolve("tmp", "build"), { recursive: true });
fs.writeFileSync(
  path.resolve("tmp", "build", "typescript_diagnostics.json"),
  JSON.stringify(errors.map(diagnostic => {
    const location = diagnostic.file && typeof diagnostic.start === "number"
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
    return {
      file: diagnostic.file ? path.relative(process.cwd(), diagnostic.file.fileName).replace(/\\/g, "/") : null,
      line: location ? location.line + 1 : null,
      character: location ? location.character + 1 : null,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    };
  }), null, 2) + "\n",
  "utf8"
);

const requiredOutputs = [
  "out/src/tests/execution_handoff/test_execution_handoff_contract_inference.js",
  "out/src/tests/execution_handoff/test_execution_handoff_contract_boundaries.js",
  "out/src/tests/execution_handoff/test_execution_handoff_unification_semantic_audit.js",
  "out/src/tests/execution_handoff/test_execution_handoff_module_declared_binding.js",
  "out/src/tests/execution_handoff/test_execution_handoff_env_ports.js"
];

const missing = requiredOutputs.filter(file => !fs.existsSync(path.resolve(file)));
if (result.emitSkipped || missing.length > 0) {
  console.error("Build emission failed.");
  if (missing.length > 0) {
    console.error("Missing required outputs:");
    for (const file of missing) {
      console.error(" - " + file);
    }
  }
  process.exit(1);
}

console.log("build=PASS");
console.log("typeDiagnostics=" + errors.length);
console.log("diagnostics=tmp/build/typescript_diagnostics.json");
