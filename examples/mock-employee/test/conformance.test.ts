import { runConformanceSuite } from '@cruzclaw/voice-core';
import { createMockHarness } from '../src/index.ts';

runConformanceSuite('mock-employee', createMockHarness);
