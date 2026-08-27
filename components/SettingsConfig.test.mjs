import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("provider usage visibility is a persisted UI setting enabled by default", async () => {
  const settingsSource = await readFile(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  assert.match(settingsSource, /id: "provider-usage"/);
  assert.match(settingsSource, /providerUsageVisible: boolean/);
  assert.match(settingsSource, /checked=\{providerUsageVisible\}/);
  assert.match(settingsSource, /onChange=\{onProviderUsageVisibleChange\}/);
  assert.match(shellSource, /const \[providerUsageVisible, setProviderUsageVisible\] = useState\(true\)/);
  assert.match(shellSource, /PROVIDER_USAGE_VISIBLE_STORAGE_KEY/);
  assert.match(shellSource, /showChat && providerUsageVisible &&/);
});
