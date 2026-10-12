import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  formatAnswer,
  OTHER_VALUE,
  parseQuestions,
  type Question,
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
});
