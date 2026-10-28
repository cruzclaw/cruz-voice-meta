import { runConformanceSuite } from '@cruzclaw/voice-core/conformance';
import { createMockHarness } from '../src/index.js';

runConformanceSuite('mock-employee', createMockHarness);
