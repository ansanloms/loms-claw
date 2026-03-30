import { assertEquals } from "@std/assert";
import { Buffer } from "node:buffer";
import { calcRms, pcmToWav } from "./codec.ts";

Deno.test("pcmToWav", async (t) => {
  await t.step("44 バイトの WAV ヘッダが付与されること", () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm);
    assertEquals(wav.length, 44 + 100);
  });

  await t.step("RIFF ヘッダが正しいこと", () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm);
    assertEquals(wav.toString("ascii", 0, 4), "RIFF");
    assertEquals(wav.toString("ascii", 8, 12), "WAVE");
    assertEquals(wav.toString("ascii", 12, 16), "fmt ");
    assertEquals(wav.toString("ascii", 36, 40), "data");
  });

  await t.step("ファイルサイズフィールドが正しいこと", () => {
    const pcm = Buffer.alloc(200);
    const wav = pcmToWav(pcm);
    // RIFF チャンクサイズ = 36 + dataSize
    assertEquals(wav.readUInt32LE(4), 36 + 200);
    // data チャンクサイズ = dataSize
    assertEquals(wav.readUInt32LE(40), 200);
  });

  await t.step("48 kHz モノラル 16 ビット PCM フォーマットであること", () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm);
    assertEquals(wav.readUInt16LE(20), 1); // PCM
    assertEquals(wav.readUInt16LE(22), 1); // モノラル
    assertEquals(wav.readUInt32LE(24), 48000); // サンプルレート
    assertEquals(wav.readUInt16LE(34), 16); // ビット深度
  });

  await t.step("PCM データがヘッダの後にそのまま続くこと", () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wav = pcmToWav(pcm);
    assertEquals(wav[44], 0x01);
    assertEquals(wav[45], 0x02);
    assertEquals(wav[46], 0x03);
    assertEquals(wav[47], 0x04);
  });
});

Deno.test("calcRms", async (t) => {
  await t.step("無音の PCM は 0 を返すこと", () => {
    const pcm = Buffer.alloc(200); // 全サンプル 0
    assertEquals(calcRms(pcm), 0);
  });

  await t.step("最大振幅の PCM は 32767 に近い値を返すこと", () => {
    // 全サンプルを最大値 (32767) に設定
    const pcm = Buffer.alloc(200);
    for (let i = 0; i < pcm.length; i += 2) {
      pcm.writeInt16LE(32767, i);
    }
    const rms = calcRms(pcm);
    assertEquals(rms, 32767);
  });

  await t.step("振幅が大きいほど RMS が高くなること", () => {
    const quiet = Buffer.alloc(200);
    const loud = Buffer.alloc(200);
    for (let i = 0; i < 200; i += 2) {
      quiet.writeInt16LE(100, i);
      loud.writeInt16LE(10000, i);
    }
    assertEquals(calcRms(quiet) < calcRms(loud), true);
  });

  await t.step("空バッファは NaN ではなく 0 を返すこと", () => {
    const pcm = Buffer.alloc(0);
    assertEquals(calcRms(pcm), 0);
  });
});
