import { Router } from 'express';
import familiasRouter from './routes/familias';
import marginsRouter from './routes/margins';
import adminRouter from './routes/admin';
import menuRouter from './routes/menu';
import collectionMappingRouter from './routes/collection-mapping';
import tagsRouter from './routes/tags';
import aiPopulateRouter from './routes/ai-populate';

const router = Router();

router.use('/familias', familiasRouter);
router.use('/margins', marginsRouter);
router.use('/admin', adminRouter);
router.use('/menu', menuRouter);
router.use('/collection-mapping', collectionMappingRouter);
router.use('/tags', tagsRouter);
router.use('/tags', aiPopulateRouter);

export default router;
