import { assertEquals } from "@std/assert";
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

Deno.test("parseQuestions", async (t) => {
  await t.step("正しい入力から質問一覧を取り出せること", () => {
    const questions = parseQuestions(validInput());

    assertEquals(questions?.length, 1);
    assertEquals(questions?.[0].question, "Which library should we use?");
    assertEquals(questions?.[0].header, "Library");
    assertEquals(questions?.[0].options.length, 2);
    assertEquals(questions?.[0].options[0], {
      label: "date-fns",
      description: "Lightweight",
    });
    assertEquals(questions?.[0].multiSelect, false);
  });

  await t.step("multiSelect 欠落は false 扱いになること", () => {
    const input = validInput();
    const q = (input.questions as Record<string, unknown>[])[0];
    delete q.multiSelect;

    assertEquals(parseQuestions(input)?.[0].multiSelect, false);
  });

  await t.step("description 欠落は空文字になること", () => {
    const input = validInput();
    const q = (input.questions as Record<string, unknown>[])[0];
    q.options = [{ label: "a" }, { label: "b" }];

    assertEquals(parseQuestions(input)?.[0].options[0].description, "");
  });

  await t.step("questions が配列でなければ undefined を返すこと", () => {
    assertEquals(parseQuestions({}), undefined);
    assertEquals(parseQuestions({ questions: "invalid" }), undefined);
  });

  await t.step("質問が 0 件なら undefined を返すこと", () => {
    assertEquals(parseQuestions({ questions: [] }), undefined);
  });

  await t.step("質問が 5 件以上なら undefined を返すこと", () => {
    const q = (validInput().questions as unknown[])[0];
    assertEquals(parseQuestions({ questions: [q, q, q, q, q] }), undefined);
  });

  await t.step(
    "question / header / options 欠落は undefined を返すこと",
    () => {
      const base = (validInput().questions as Record<string, unknown>[])[0];

      for (const key of ["question", "header", "options"]) {
        const broken = { ...base };
        delete broken[key];
        assertEquals(parseQuestions({ questions: [broken] }), undefined);
      }
    },
  );

  await t.step("選択肢が空配列なら undefined を返すこと", () => {
    const base = (validInput().questions as Record<string, unknown>[])[0];
    assertEquals(
      parseQuestions({ questions: [{ ...base, options: [] }] }),
      undefined,
    );
  });

  await t.step("選択肢の label 欠落は undefined を返すこと", () => {
    const base = (validInput().questions as Record<string, unknown>[])[0];
    assertEquals(
      parseQuestions({
        questions: [{ ...base, options: [{ description: "x" }] }],
      }),
      undefined,
    );
  });
});

Deno.test("resolveSelectedLabels", async (t) => {
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

  await t.step("value (index 文字列) をラベルに解決すること", () => {
    assertEquals(resolveSelectedLabels(question, ["0", "2"]), {
      labels: ["Alpha", "Gamma"],
      hasOther: false,
    });
  });

  await t.step("Other の value を hasOther として検出すること", () => {
    assertEquals(resolveSelectedLabels(question, ["1", OTHER_VALUE]), {
      labels: ["Beta"],
      hasOther: true,
    });
  });

  await t.step("不明な value は無視すること", () => {
    assertEquals(resolveSelectedLabels(question, ["99", "abc"]), {
      labels: [],
      hasOther: false,
    });
  });
});

Deno.test("formatAnswer", async (t) => {
  await t.step("単一選択はラベルそのままであること", () => {
    assertEquals(formatAnswer(["Alpha"]), "Alpha");
  });

  await t.step("複数選択は ', ' 連結であること", () => {
    assertEquals(formatAnswer(["Alpha", "Beta"]), "Alpha, Beta");
  });
});

Deno.test("truncate", async (t) => {
  await t.step("上限以下はそのまま返すこと", () => {
    assertEquals(truncate("abc", 3), "abc");
  });

  await t.step("上限超過は省略記号付きで切り詰めること", () => {
    assertEquals(truncate("abcdef", 4), "abc…");
    assertEquals(truncate("abcdef", 4).length, 4);
  });
});
