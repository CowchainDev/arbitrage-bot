import { Router, type IRouter } from "express";
import healthRouter from "./health";
import exchangesRouter from "./exchanges";
import { tradesRouter } from "./trades";
import { credentialsRouter } from "./credentials";
import { botsRouter } from "./bots";

const router: IRouter = Router();

router.use(healthRouter);
router.use(exchangesRouter);
router.use(tradesRouter);
router.use(credentialsRouter);
router.use(botsRouter);

export default router;
