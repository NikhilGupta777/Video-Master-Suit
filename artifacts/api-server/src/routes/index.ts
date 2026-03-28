import { Router, type IRouter } from "express";
import healthRouter from "./health";
import youtubeRouter from "./youtube";
import bhagwatRouter from "./bhagwat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(youtubeRouter);
router.use(bhagwatRouter);

export default router;
