import { Router, type IRouter } from "express";
import healthRouter from "./health";
import exchangesRouter from "./exchanges";

const router: IRouter = Router();

router.use(healthRouter);
router.use(exchangesRouter);

export default router;
