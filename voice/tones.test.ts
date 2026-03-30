import { assertEquals } from "@std/assert";
import { generateErrorTone, generateThinkingTone } from "./tones.ts";

Deno.test("generateThinkingTone", async (t) => {
  await t.step("有効な WAV バイト列を返すこと", () => {
    const wav = generateThinkingTone();
    assertEquals(wav.toString("ascii", 0, 4), "RIFF");
    assertEquals(wav.toString("ascii", 8, 12), "WAVE");
  });

  await t.step("44 バイト以上の長さがあること", () => {
    const wav = generateThinkingTone();
    assertEquals(wav.length > 44, true);
  });

  await t.step("呼び出しごとに同じ結果を返すこと", () => {
    const a = generateThinkingTone();
    const b = generateThinkingTone();
    assertEquals(a.equals(b), true);
  });
});

Deno.test("generateErrorTone", async (t) => {
  await t.step("有効な WAV バイト列を返すこと", () => {
    const wav = generateErrorTone();
    assertEquals(wav.toString("ascii", 0, 4), "RIFF");
    assertEquals(wav.toString("ascii", 8, 12), "WAVE");
  });

  await t.step("thinking tone とは異なるバイト列であること", () => {
    const thinking = generateThinkingTone();
    const error = generateErrorTone();
    assertEquals(thinking.equals(error), false);
  });
});
