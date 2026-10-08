import type { MatrixBridge } from '../shared/contracts';
declare global { interface Window { matrix?: MatrixBridge } }
export {};
