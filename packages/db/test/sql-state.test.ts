import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, sqlState, type Db } from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

// Errors are classified by SQLSTATE, never by message text (code review fix).

let db: Db;
beforeAll(async () => {
  db = createDb((await createTestDatabase("psl_test_db_sqlstate")).owner);
});
afterAll(() => db.$disconnect());

async function errorOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

describe("sqlState", () => {
  it("reads the SQLSTATE of a unique violation", async () => {
    const e = await errorOf(() =>
      db.$executeRaw`INSERT INTO users (id, name) VALUES
        ('00000000-0000-4000-8000-0000000000aa', 'x'), ('00000000-0000-4000-8000-0000000000aa', 'y')`,
    );
    expect(sqlState(e)).toBe("23505");
  });

  it("reads a custom SQLSTATE raised inside a transaction", async () => {
    const e = await errorOf(() =>
      db.$transaction((tx) => tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'x' USING ERRCODE = 'P0002'; END $$`),
    );
    expect(sqlState(e)).toBe("P0002");
  });

  it("returns null for anything that is not a database error", () => {
    expect(sqlState(new Error("23505 unique constraint"))).toBeNull();
    expect(sqlState(null)).toBeNull();
  });
});
