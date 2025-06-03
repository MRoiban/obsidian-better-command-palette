import plugin from 'src/main';
import { UnsafeAppInterface } from 'src/types/types';
import tests from './tests';
import { logger } from '../../src/utils/logger';

const badWindow = window as any;
const app = badWindow.app as UnsafeAppInterface;

// Wait for layout to be ready
window.addEventListener('layout-ready', () => {
    logger.info('the layout is ready for testing');
    
    for (let i = 0; i < tests.length; i++) {
        logger.info('Running test suite:', tests[i].name);
        tests[i].test();
    }
});

export default plugin;
