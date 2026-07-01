const path = require("path");
const { spawnSync } = require("child_process");

const tests = [
  "out/src/tests/execution_handoff/test_execution_handoff_contract.js",
  "out/src/tests/execution_handoff/test_execution_handoff_contract_audit.js",
  "out/src/tests/execution_handoff/test_execution_handoff_contract_coverage.js",
  "out/src/tests/execution_handoff/test_execution_handoff_contract_ablation.js",
  "out/src/tests/execution_handoff/test_execution_handoff_contract_inference.js",
  "out/src/tests/execution_handoff/test_execution_handoff_contract_boundaries.js",
  "out/src/tests/execution_handoff/test_execution_handoff_semantic_core.js",
  "out/src/tests/execution_handoff/test_execution_handoff_semantic_algorithm.js",
  "out/src/tests/execution_handoff/test_execution_handoff_unification_audit.js",
  "out/src/tests/execution_handoff/test_execution_handoff_unification_semantic_audit.js",
  "out/src/tests/execution_handoff/test_execution_handoff_module_declared_binding.js",
  "out/src/tests/execution_handoff/test_execution_handoff_env_ports.js"
];

for (const test of tests) {
  console.log("\n[ude-test] " + test);
  const result = spawnSync(process.execPath, [path.resolve(test)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("[ude-test] FAIL " + test);
    process.exit(result.status || 1);
  }
}

console.log("\nude_artifact_tests=PASS");
console.log("testCount=" + tests.length);
