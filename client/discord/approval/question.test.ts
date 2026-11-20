import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Client, StringSelectMenuInteraction } from "discord.js";
import {
  formatAnswer,
  OTHER_VALUE,
  parseQuestions,
  type Question,
  QuestionManager,
  resolveSelectedLabels,
  truncate,
} from "./question.ts";

/**
 * テスト用の質問入力を生成する。
 */
function validInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: "Which library should we use?",
        header: "Library",
        options: [
          { label: "date-fns", description: "Lightweight" },
          { label: "dayjs", description: "Small API" },
        ],
        multiSelect: false,
      },
    ],
  };
}

describe("parseQuestions", () => {
  test("正しい入力から質問一覧を取り出せること", () => {
    const questions = parseQuestions(validInput());

    assert.deepStrictEqual(questions?.length, 1);
    assert.deepStrictEqual(
      questions?.[0].question,
      "Which library should we use?",
    );
    assert.deepStrictEqual(questions?.[0].header, "Library");
    assert.deepStrictEqual(questions?.[0].options.length, 2);
    assert.deepStrictEqual(questions?.[0].options[0], {
      label: "date-fns",
      description: "Lightweight",
    });
    assert.deepStrictEqual(questions?.[0].multiSelect, false);
  });

  test("multiSelect 欠落は false 扱いになること", () => {
    const input = validInput();
    const q = (input.questions as Record<string, unknown>[])[0];
    delete q.multiSelect;

    assert.deepStrictEqual(parseQuestions(input)?.[0].multiSelect, false);
  });

  test("description 欠落は空文字になること", () => {
    const input = validInput();
    const q = (input.questions as Record<string, unknown>[])[0];
    q.options = [{ label: "a" }, { label: "b" }];

    assert.deepStrictEqual(
      parseQuestions(input)?.[0].options[0].description,
      "",
    );
  });

  test("questions が配列でなければ undefined を返すこと", () => {
    assert.deepStrictEqual(parseQuestions({}), undefined);
    assert.deepStrictEqual(parseQuestions({ questions: "invalid" }), undefined);
  });

  test("質問が 0 件なら undefined を返すこと", () => {
    assert.deepStrictEqual(parseQuestions({ questions: [] }), undefined);
  });

  test("質問が 5 件以上なら undefined を返すこと", () => {
    const q = (validInput().questions as unknown[])[0];
    assert.deepStrictEqual(
      parseQuestions({ questions: [q, q, q, q, q] }),
      undefined,
    );
  });

  test("question / header / options 欠落は undefined を返すこと", () => {
    const base = (validInput().questions as Record<string, unknown>[])[0];

    for (const key of ["question", "header", "options"]) {
      const broken = { ...base };
      delete broken[key];
      assert.deepStrictEqual(
        parseQuestions({ questions: [broken] }),
        undefined,
      );
    }
  });

  test("選択肢が空配列なら undefined を返すこと", () => {
    const base = (validInput().questions as Record<string, unknown>[])[0];
    assert.deepStrictEqual(
      parseQuestions({ questions: [{ ...base, options: [] }] }),
      undefined,
    );
  });

  test("選択肢の label 欠落は undefined を返すこと", () => {
    const base = (validInput().questions as Record<string, unknown>[])[0];
    assert.deepStrictEqual(
      parseQuestions({
        questions: [{ ...base, options: [{ description: "x" }] }],
      }),
      undefined,
    );
  });
});

describe("resolveSelectedLabels", () => {
  const question: Question = {
    question: "q",
    header: "h",
    options: [
      { label: "Alpha", description: "" },
      { label: "Beta", description: "" },
      { label: "Gamma", description: "" },
    ],
    multiSelect: true,
  };

  test("value (index 文字列) をラベルに解決すること", () => {
    assert.deepStrictEqual(resolveSelectedLabels(question, ["0", "2"]), {
      labels: ["Alpha", "Gamma"],
      hasOther: false,
    });
  });

  test("Other の value を hasOther として検出すること", () => {
    assert.deepStrictEqual(
      resolveSelectedLabels(question, ["1", OTHER_VALUE]),
      {
        labels: ["Beta"],
        hasOther: true,
      },
    );
  });

  test("不明な value は無視すること", () => {
    assert.deepStrictEqual(resolveSelectedLabels(question, ["99", "abc"]), {
      labels: [],
      hasOther: false,
    });
  });
});

describe("formatAnswer", () => {
  test("単一選択はラベルそのままであること", () => {
    assert.deepStrictEqual(formatAnswer(["Alpha"]), "Alpha");
  });

  test("複数選択は ', ' 連結であること", () => {
    assert.deepStrictEqual(formatAnswer(["Alpha", "Beta"]), "Alpha, Beta");
  });
});

describe("truncate", () => {
  test("上限以下はそのまま返すこと", () => {
    assert.deepStrictEqual(truncate("abc", 3), "abc");
  });

  test("上限超過は省略記号付きで切り詰めること", () => {
    assert.deepStrictEqual(truncate("abcdef", 4), "abc…");
    assert.deepStrictEqual(truncate("abcdef", 4).length, 4);
  });

  test("切れ目がサロゲートペアの途中なら上位サロゲートを残さないこと", () => {
    // "a" + 😀 (2 単位) + "b" を max=3 で切ると slice(0, 2) が上位サロゲートで終わる。
    const result = truncate("a😀b", 3);
    assert.deepStrictEqual(result, "a…");
  });
});

describe("QuestionManager.requestAnswers", () => {
  test("send の待機中に abort されたら Aborted へ編集して denied を返すこと", async () => {
    const controller = new AbortController();
    const edits: { content: string; components: [] }[] = [];
    const client = {
      channels: {
        fetch: () =>
          Promise.resolve({
            isTextBased: () => true,
            send: (payload: { content: string }) => {
              controller.abort();
              return Promise.resolve({
                content: payload.content,
                edit: (edit: { content: string; components: [] }) => {
                  edits.push(edit);
                  return Promise.resolve();
                },
              });
            },
          }),
      },
    } as unknown as Client;
    const questions = parseQuestions(validInput());
    assert.ok(questions);

    const result = await new QuestionManager(client).requestAnswers(
      questions,
      "ch-1",
      controller.signal,
    );

    assert.deepStrictEqual(result, { kind: "denied", reason: "Aborted" });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(edits.length, 1);
    assert.ok(edits[0].content.endsWith("\n**→ Aborted**"));
  });

  test("channels.fetch が reject したら denied を返すこと", async () => {
    const client = {
      channels: { fetch: () => Promise.reject(new Error("fetch failed")) },
    } as unknown as Client;
    const questions = parseQuestions(validInput());
    assert.ok(questions);

    const result = await new QuestionManager(client).requestAnswers(
      questions,
      "ch-1",
    );

    assert.deepStrictEqual(result, {
      kind: "denied",
      reason: "Failed to resolve channel",
    });
  });

  test("send が reject したら denied を返すこと", async () => {
    const client = {
      channels: {
        fetch: () =>
          Promise.resolve({
            isTextBased: () => true,
            send: () => Promise.reject(new Error("send failed")),
          }),
      },
    } as unknown as Client;
    const questions = parseQuestions(validInput());
    assert.ok(questions);

    const result = await new QuestionManager(client).requestAnswers(
      questions,
      "ch-1",
    );

    assert.deepStrictEqual(result, {
      kind: "denied",
      reason: "Failed to post questions",
    });
  });
});

describe("QuestionManager 回答済みの表示", () => {
  /**
   * 質問を送信し、全問を select で回答して、回答後の `update` の content を返す。
   */
  async function answerAll(
    questions: Question[],
    body: string,
    otherTexts?: string[],
  ): Promise<string> {
    let customIds: string[] = [];
    const client = {
      channels: {
        fetch: () =>
          Promise.resolve({
            isTextBased: () => true,
            send: (payload: {
              content: string;
              components: { components: { data: { custom_id: string } }[] }[];
            }) => {
              customIds = payload.components.map(
                (row) => row.components[0].data.custom_id,
              );
              return Promise.resolve({
                content: body,
                edit: () => Promise.resolve(),
              });
            },
          }),
      },
    } as unknown as Client;
    const manager = new QuestionManager(client);
    const resultPromise = manager.requestAnswers(questions, "ch-1");
    await new Promise((r) => setTimeout(r, 0));

    let updated = "";
    for (let i = 0; i < questions.length; i++) {
      const other = otherTexts?.[i];
      if (other !== undefined) {
        const modal = {
          customId: customIds[i].replace("question:", "question-other:"),
          fields: { getTextInputValue: () => other },
          isFromMessage: () => true,
          message: { content: body },
          update: (edit: { content?: string }) => {
            if (edit.content !== undefined) {
              updated = edit.content;
            }
            return Promise.resolve();
          },
        };
        // handleSelect の Other 経路で pendingOther を作る。
        await manager.handleSelect({
          customId: customIds[i],
          values: [OTHER_VALUE],
          showModal: () => Promise.resolve(),
        } as unknown as StringSelectMenuInteraction);
        await manager.handleModal(modal as never);
      } else {
        await manager.handleSelect({
          customId: customIds[i],
          values: ["0"],
          message: { content: body },
          update: (edit: { content?: string }) => {
            if (edit.content !== undefined) {
              updated = edit.content;
            }
            return Promise.resolve();
          },
        } as unknown as StringSelectMenuInteraction);
      }
    }
    await resultPromise;
    return updated;
  }

  function makeQuestions(count: number, header = "H"): Question[] {
    return Array.from({ length: count }, (_, i) => ({
      question: `Q${i}`,
      header,
      options: [{ label: "A", description: "" }],
      multiSelect: false,
    }));
  }

  test("本文が上限に近くても、→ 回答済み と要約が残り 2000 文字以内であること", async () => {
    const body = "x".repeat(1990);
    const content = await answerAll(makeQuestions(1, "Choice"), body);

    assert.ok(content.length <= 2000);
    assert.ok(content.includes("**→ 回答済み**"));
    assert.ok(content.endsWith("**Choice**: A"));
  });

  test("1000 文字の Other を 4 件回答しても、2000 文字以内で → 回答済み が残ること", async () => {
    const body = "x".repeat(1990);
    const long = "y".repeat(1000);
    const content = await answerAll(makeQuestions(4), body, [
      long,
      long,
      long,
      long,
    ]);

    assert.ok(content.length <= 2000);
    assert.ok(content.includes("**→ 回答済み**"));
    assert.ok(content.includes("**H**: "));
    // 各質問の回答の先頭が残っていること。
    assert.deepStrictEqual(content.match(/\*\*H\*\*: y{10}/g)?.length, 4);
  });

  test("回答に 3 連のバッククォートがあっても、表示に 3 連のバッククォートが残らないこと", async () => {
    const content = await answerAll(makeQuestions(2), "body", [
      "a ``` b ````` c",
      "```",
    ]);

    assert.ok(content.includes("**→ 回答済み**"));
    assert.ok(!content.includes("```"));
  });

  test("header が 500 文字でも回答の先頭が残ること", async () => {
    const content = await answerAll(makeQuestions(1, "h".repeat(500)), "body", [
      "ANSWER-START" + "z".repeat(500),
    ]);

    assert.ok(content.includes("**→ 回答済み**"));
    assert.ok(content.includes("ANSWER-START"));
  });
});
