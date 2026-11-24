import test from "node:test";
import assert from "node:assert/strict";
import { agyModels } from "./chat-models.js";
test("Antigravity groups real model variants and keeps models without effort controls", () => {
  const rows = agyModels(
    "Fetching available models...\nfixture-gemini-high\tGemini (High)\nfixture-gemini-low\tGemini (Low)\nfixture-model\tModel\nfixture-fixed-medium\tFixed (Medium)\n",
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.name, r.efforts]),
    [
      ["fixture-gemini", "Gemini", ["low", "high"]],
      ["fixture-model", "Model", []],
      ["fixture-fixed-medium", "Fixed (Medium)", []],
    ],
  );
});
