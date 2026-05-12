import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { CreateBotBody, UpdateBotBody } from "@workspace/api-zod";
import { buildBotUpdateFields } from "./bots.js";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = "test-user";
    next();
  },
  requireBotSecret: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("@workspace/db", async () => {
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
  });
  const selectFn = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
      orderBy: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
  });
  const deleteFn = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
  });
  return {
    db: { update, insert, select: selectFn, delete: deleteFn },
    botConfigsTable: {},
    botLegsTable: {},
  };
});

vi.mock("../services/bot-watcher.js", () => ({
  closeAllLegsForBot: vi.fn().mockResolvedValue(undefined),
}));

async function buildApp() {
  const { botsRouter } = await import("./bots.js");
  const app = express();
  app.use(express.json());
  app.use("/api", botsRouter);
  return app;
}

describe("PUT /api/bots/:id – empty-body guard", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("returns 400 when the body is empty", async () => {
    const res = await request(app)
      .put("/api/bots/1")
      .send({})
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(res.body.message).toMatch(/no fields/i);
  });

  it("returns 400 when the body contains only unrecognised keys", async () => {
    const res = await request(app)
      .put("/api/bots/1")
      .send({ unknownField: 999 })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("passes the empty-body guard and reaches the DB when a valid field is provided", async () => {
    const res = await request(app)
      .put("/api/bots/1")
      .send({ enterSpreadPct: 0.5 })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});

describe("buildBotUpdateFields", () => {
  it("returns an empty object for an empty data shape", () => {
    const updates = buildBotUpdateFields({});
    expect(Object.keys(updates)).toHaveLength(0);
  });

  it("maps a single valid field and string-casts numeric spread fields", () => {
    const updates = buildBotUpdateFields({ enterSpreadPct: 0.5 });
    expect(updates.enterSpreadPct).toBe("0.5");
    expect(Object.keys(updates)).toHaveLength(1);
  });

  it("maps multiple valid fields correctly", () => {
    const updates = buildBotUpdateFields({
      enterSpreadPct: 0.1,
      closeSpreadPct: 0.2,
      orderSizeUsd: 100,
    });
    expect(Object.keys(updates)).toHaveLength(3);
    expect(updates.enterSpreadPct).toBe("0.1");
    expect(updates.closeSpreadPct).toBe("0.2");
    expect(updates.orderSizeUsd).toBe("100");
  });

  it("does not include updatedAt in the returned fields", () => {
    const updates = buildBotUpdateFields({ maxOrders: 5 });
    expect(updates).not.toHaveProperty("updatedAt");
  });
});

describe("PUT /bots/:id – Zod + buildBotUpdateFields pipeline", () => {
  it("empty body parses successfully but produces no update fields", () => {
    const parsed = UpdateBotBody.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const updates = buildBotUpdateFields(parsed.data);
    expect(Object.keys(updates)).toHaveLength(0);
  });

  it("invalid field type fails Zod parse before reaching update building", () => {
    const parsed = UpdateBotBody.safeParse({ enterSpreadPct: "not-a-number" });
    expect(parsed.success).toBe(false);
  });

  it("valid payload passes Zod and produces non-empty update fields", () => {
    const parsed = UpdateBotBody.safeParse({ enterSpreadPct: 0.25, maxOrders: 3 });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const updates = buildBotUpdateFields(parsed.data);
    expect(Object.keys(updates).length).toBeGreaterThan(0);
    expect(updates.enterSpreadPct).toBe("0.25");
    expect(updates.maxOrders).toBe(3);
  });
});

describe("UpdateBotBody – range / boundary validation", () => {
  describe("enterSpreadPct", () => {
    it("rejects zero", () => {
      expect(UpdateBotBody.safeParse({ enterSpreadPct: 0 }).success).toBe(false);
    });

    it("rejects negative values", () => {
      expect(UpdateBotBody.safeParse({ enterSpreadPct: -0.5 }).success).toBe(false);
    });

    it("accepts a small positive value", () => {
      expect(UpdateBotBody.safeParse({ enterSpreadPct: 0.01 }).success).toBe(true);
    });
  });

  describe("closeSpreadPct", () => {
    it("rejects zero", () => {
      expect(UpdateBotBody.safeParse({ closeSpreadPct: 0 }).success).toBe(false);
    });

    it("rejects negative values", () => {
      expect(UpdateBotBody.safeParse({ closeSpreadPct: -1 }).success).toBe(false);
    });

    it("accepts a positive value", () => {
      expect(UpdateBotBody.safeParse({ closeSpreadPct: 0.5 }).success).toBe(true);
    });
  });

  describe("stopLossSpreadPct", () => {
    it("accepts zero (disabled)", () => {
      expect(UpdateBotBody.safeParse({ stopLossSpreadPct: 0 }).success).toBe(true);
    });

    it("rejects negative values", () => {
      expect(UpdateBotBody.safeParse({ stopLossSpreadPct: -0.1 }).success).toBe(false);
    });

    it("accepts a positive value", () => {
      expect(UpdateBotBody.safeParse({ stopLossSpreadPct: 1.5 }).success).toBe(true);
    });
  });

  describe("orderSizeUsd", () => {
    it("rejects zero", () => {
      expect(UpdateBotBody.safeParse({ orderSizeUsd: 0 }).success).toBe(false);
    });

    it("rejects negative values", () => {
      expect(UpdateBotBody.safeParse({ orderSizeUsd: -100 }).success).toBe(false);
    });

    it("accepts values >= 1", () => {
      expect(UpdateBotBody.safeParse({ orderSizeUsd: 1 }).success).toBe(true);
      expect(UpdateBotBody.safeParse({ orderSizeUsd: 500 }).success).toBe(true);
    });
  });

  describe("maxOrders", () => {
    it("rejects zero", () => {
      expect(UpdateBotBody.safeParse({ maxOrders: 0 }).success).toBe(false);
    });

    it("rejects negative values", () => {
      expect(UpdateBotBody.safeParse({ maxOrders: -1 }).success).toBe(false);
    });

    it("rejects non-integer values", () => {
      expect(UpdateBotBody.safeParse({ maxOrders: 1.5 }).success).toBe(false);
    });

    it("accepts positive integers", () => {
      expect(UpdateBotBody.safeParse({ maxOrders: 1 }).success).toBe(true);
      expect(UpdateBotBody.safeParse({ maxOrders: 10 }).success).toBe(true);
    });
  });

  describe("leverage fields (bybitLeverage, binanceLeverage, leverageA, leverageB)", () => {
    const leverageFields = ["bybitLeverage", "binanceLeverage", "leverageA", "leverageB"] as const;

    for (const field of leverageFields) {
      it(`${field}: rejects 0`, () => {
        expect(UpdateBotBody.safeParse({ [field]: 0 }).success).toBe(false);
      });

      it(`${field}: rejects values below 1`, () => {
        expect(UpdateBotBody.safeParse({ [field]: -5 }).success).toBe(false);
      });

      it(`${field}: rejects values above 125`, () => {
        expect(UpdateBotBody.safeParse({ [field]: 126 }).success).toBe(false);
      });

      it(`${field}: rejects non-integer values`, () => {
        expect(UpdateBotBody.safeParse({ [field]: 2.5 }).success).toBe(false);
      });

      it(`${field}: accepts boundary value 1`, () => {
        expect(UpdateBotBody.safeParse({ [field]: 1 }).success).toBe(true);
      });

      it(`${field}: accepts boundary value 125`, () => {
        expect(UpdateBotBody.safeParse({ [field]: 125 }).success).toBe(true);
      });

      it(`${field}: accepts a valid mid-range value`, () => {
        expect(UpdateBotBody.safeParse({ [field]: 10 }).success).toBe(true);
      });
    }
  });

  it("accepts a fully-populated valid payload", () => {
    const result = UpdateBotBody.safeParse({
      enterSpreadPct: 0.3,
      closeSpreadPct: 0.1,
      stopLossSpreadPct: 0,
      orderSizeUsd: 200,
      maxOrders: 5,
      forceStopUsd: -500,
      bybitLeverage: 10,
      binanceLeverage: 10,
      leverageA: 5,
      leverageB: 5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload where only one field is out of range", () => {
    const result = UpdateBotBody.safeParse({
      enterSpreadPct: 0.3,
      orderSizeUsd: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("POST /api/bots – empty-body guard", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("returns 400 when the body is completely empty", async () => {
    const res = await request(app)
      .post("/api/bots")
      .send({})
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(res.body.message).toMatch(/must not be empty/i);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/bots")
      .send({ symbol: "BTC" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("returns 400 when numeric fields have wrong types", async () => {
    const res = await request(app)
      .post("/api/bots")
      .send({
        symbol: "BTC",
        enterSpreadPct: "not-a-number",
        closeSpreadPct: 0.1,
        orderSizeUsd: 100,
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("passes the guard when all required fields are present", async () => {
    const res = await request(app)
      .post("/api/bots")
      .send({
        symbol: "BTC",
        enterSpreadPct: 0.3,
        closeSpreadPct: 0.1,
        orderSizeUsd: 100,
      })
      .set("Content-Type", "application/json");

    expect(res.status).not.toBe(400);
  });
});

describe("POST /bots – CreateBotBody Zod schema", () => {
  it("rejects an empty body", () => {
    const parsed = CreateBotBody.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("rejects a body missing required numeric fields", () => {
    const parsed = CreateBotBody.safeParse({ symbol: "ETH" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a body where a required numeric field has a string value", () => {
    const parsed = CreateBotBody.safeParse({
      symbol: "BTC",
      enterSpreadPct: "high",
      closeSpreadPct: 0.1,
      orderSizeUsd: 100,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a minimal valid body with only required fields", () => {
    const parsed = CreateBotBody.safeParse({
      symbol: "BTC",
      enterSpreadPct: 0.3,
      closeSpreadPct: 0.1,
      orderSizeUsd: 100,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a full body with all optional fields provided", () => {
    const parsed = CreateBotBody.safeParse({
      symbol: "ETH",
      enterSpreadPct: 0.25,
      closeSpreadPct: 0.05,
      orderSizeUsd: 200,
      stopLossSpreadPct: 0.5,
      maxOrders: 3,
      forceStopUsd: 50,
      bybitLeverage: 2,
      binanceLeverage: 2,
      exchangeA: "bybit",
      exchangeB: "binance",
      leverageA: 2,
      leverageB: 2,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("POST /bots – CreateBotBody range constraints", () => {
  const validBase = {
    symbol: "BTC",
    enterSpreadPct: 0.3,
    closeSpreadPct: 0.1,
    orderSizeUsd: 100,
  };

  describe("enterSpreadPct", () => {
    it("rejects zero", () => {
      expect(CreateBotBody.safeParse({ ...validBase, enterSpreadPct: 0 }).success).toBe(false);
    });
    it("rejects negative values", () => {
      expect(CreateBotBody.safeParse({ ...validBase, enterSpreadPct: -0.1 }).success).toBe(false);
    });
    it("accepts a small positive value", () => {
      expect(CreateBotBody.safeParse({ ...validBase, enterSpreadPct: 0.0001 }).success).toBe(true);
    });
  });

  describe("closeSpreadPct", () => {
    it("rejects zero", () => {
      expect(CreateBotBody.safeParse({ ...validBase, closeSpreadPct: 0 }).success).toBe(false);
    });
    it("rejects negative values", () => {
      expect(CreateBotBody.safeParse({ ...validBase, closeSpreadPct: -0.1 }).success).toBe(false);
    });
    it("accepts a small positive value", () => {
      expect(CreateBotBody.safeParse({ ...validBase, closeSpreadPct: 0.0001 }).success).toBe(true);
    });
  });

  describe("stopLossSpreadPct", () => {
    it("accepts zero (disabled)", () => {
      expect(CreateBotBody.safeParse({ ...validBase, stopLossSpreadPct: 0 }).success).toBe(true);
    });
    it("rejects negative values", () => {
      expect(CreateBotBody.safeParse({ ...validBase, stopLossSpreadPct: -0.1 }).success).toBe(false);
    });
    it("accepts a positive value", () => {
      expect(CreateBotBody.safeParse({ ...validBase, stopLossSpreadPct: 0.5 }).success).toBe(true);
    });
  });

  describe("orderSizeUsd", () => {
    it("rejects zero", () => {
      expect(CreateBotBody.safeParse({ ...validBase, orderSizeUsd: 0 }).success).toBe(false);
    });
    it("rejects negative values", () => {
      expect(CreateBotBody.safeParse({ ...validBase, orderSizeUsd: -50 }).success).toBe(false);
    });
    it("accepts values >= 1", () => {
      expect(CreateBotBody.safeParse({ ...validBase, orderSizeUsd: 1 }).success).toBe(true);
    });
  });

  describe("maxOrders", () => {
    it("rejects zero", () => {
      expect(CreateBotBody.safeParse({ ...validBase, maxOrders: 0 }).success).toBe(false);
    });
    it("rejects negative values", () => {
      expect(CreateBotBody.safeParse({ ...validBase, maxOrders: -1 }).success).toBe(false);
    });
    it("rejects non-integer values", () => {
      expect(CreateBotBody.safeParse({ ...validBase, maxOrders: 1.5 }).success).toBe(false);
    });
    it("accepts positive integers", () => {
      expect(CreateBotBody.safeParse({ ...validBase, maxOrders: 3 }).success).toBe(true);
    });
  });

  describe("leverage fields (bybitLeverage, binanceLeverage, leverageA, leverageB)", () => {
    const leverageFields = ["bybitLeverage", "binanceLeverage", "leverageA", "leverageB"] as const;
    for (const field of leverageFields) {
      it(`${field}: rejects 0`, () => {
        expect(CreateBotBody.safeParse({ ...validBase, [field]: 0 }).success).toBe(false);
      });
      it(`${field}: rejects values above 125`, () => {
        expect(CreateBotBody.safeParse({ ...validBase, [field]: 126 }).success).toBe(false);
      });
      it(`${field}: rejects non-integer values`, () => {
        expect(CreateBotBody.safeParse({ ...validBase, [field]: 1.5 }).success).toBe(false);
      });
      it(`${field}: accepts boundary value 1`, () => {
        expect(CreateBotBody.safeParse({ ...validBase, [field]: 1 }).success).toBe(true);
      });
      it(`${field}: accepts boundary value 125`, () => {
        expect(CreateBotBody.safeParse({ ...validBase, [field]: 125 }).success).toBe(true);
      });
    }
  });
});

describe("POST /api/bots – inverted spread cross-field check", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("returns 400 when closeSpreadPct equals enterSpreadPct", async () => {
    const res = await request(app)
      .post("/api/bots")
      .send({ symbol: "BTC", enterSpreadPct: 0.2, closeSpreadPct: 0.2, orderSizeUsd: 100 })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(res.body.message).toMatch(/closeSpreadPct must be less than enterSpreadPct/i);
  });

  it("returns 400 when closeSpreadPct is greater than enterSpreadPct", async () => {
    const res = await request(app)
      .post("/api/bots")
      .send({ symbol: "BTC", enterSpreadPct: 0.1, closeSpreadPct: 0.3, orderSizeUsd: 100 })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(res.body.message).toMatch(/closeSpreadPct must be less than enterSpreadPct/i);
  });

  it("passes when closeSpreadPct is strictly less than enterSpreadPct", async () => {
    const res = await request(app)
      .post("/api/bots")
      .send({ symbol: "BTC", enterSpreadPct: 0.3, closeSpreadPct: 0.1, orderSizeUsd: 100 })
      .set("Content-Type", "application/json");

    expect(res.status).not.toBe(400);
  });

  it("returns 400 when enterSpreadPct is zero (Zod check fires before cross-field check)", async () => {
    const res = await request(app)
      .post("/api/bots")
      .send({ symbol: "BTC", enterSpreadPct: 0, closeSpreadPct: 0.1, orderSizeUsd: 100 })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });
});
