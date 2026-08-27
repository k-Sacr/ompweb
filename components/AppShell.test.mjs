import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("usage has a separate trigger and all-model panel", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /data-provider-usage-trigger/);
  assert.match(source, /toggleTopPanel\("usage"\)/);
  assert.match(source, /fetch\("\/api\/provider-usage"/);
  assert.match(source, /allProviderUsage\.reports/);
  assert.match(source, /appShell\.allModels/);

  const usageTrigger = source.match(/data-provider-usage-trigger[\s\S]*?<\/button>/)?.[0];
  assert.ok(usageTrigger);
  assert.doesNotMatch(usageTrigger, /className=/);
  assert.match(source, /data-topbar-right-group[\s\S]*data-provider-usage-trigger[\s\S]*ref={sessionStatsBtnRef}/);
  assert.match(source, /right: activeTopPanel === "usage" \? topPanelPos\.right : 12/);

  const sessionButton = source.match(/ref={sessionStatsBtnRef}[\s\S]*?<\/button>/)?.[0];
  assert.ok(sessionButton);
  assert.match(sessionButton, /marginLeft:\s*"auto"/);
});
