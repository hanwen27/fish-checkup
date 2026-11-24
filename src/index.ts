/**
 * World 定义入口：装配层按这个挂载，Core 按这个构造实例。
 * 逻辑全在 world.ts 与几个 .mjs 里；这里只做导出。
 */
import type { WorldDefinition, WorldContext } from 'cortico/world.ts';
import { CHECKUP_DEFAULTS, CHECKUP_ID, CHECKUP_WORLD, CheckupWorld, type CheckupSection } from './world.ts';

export { CHECKUP_ID, CHECKUP_DEFAULTS, CheckupWorld, type CheckupSection };
export { CHECKUP_WORLD as definition };

export const CHECKUP: WorldDefinition<CheckupSection> = CHECKUP_WORLD;

export default CHECKUP_WORLD;
