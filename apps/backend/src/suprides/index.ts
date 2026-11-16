import { Router } from 'express';
import familiasRouter          from './routes/familias';
import mappingsRouter          from './routes/mappings';
import marginsRouter           from './routes/margins';
import adminRouter             from './routes/admin';
import menuRouter              from './routes/menu';
import syncRouter              from './routes/sync';
import syncImagesRouter        from './routes/sync-images';
import collectionMappingRouter from './routes/collection-mapping';
import publicMenuRouter        from './routes/public-menu';
import cacheRouter             from './routes/cache';
import tagsRouter              from './routes/tags';
import aiPopulateRouter        from './routes/ai-populate';

const router = Router();

router.use('/familias',           familiasRouter);
router.use('/mappings',           mappingsRouter);
router.use('/margins',            marginsRouter);
router.use('/admin',              adminRouter);
router.use('/menu',               menuRouter);
router.use('/collection-mapping', collectionMappingRouter);
router.use('/public-menu',        publicMenuRouter);
router.use('/cache',              cacheRouter);
router.use('/tags',               tagsRouter);
router.use('/tags',               aiPopulateRouter);
router.use('/sync-images',        syncImagesRouter);
router.use('/',                   syncRouter);

export default router;
