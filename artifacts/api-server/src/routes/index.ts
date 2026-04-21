import { Router, type IRouter } from "express";
import healthRouter from "./health";
import exchangesRouter from "./exchanges";
import { tradesRouter } from "./trades";

const router: IRouter = Router();

router.use(healthRouter);
router.use(exchangesRouter);
router.use(tradesRouter);

export default router;
