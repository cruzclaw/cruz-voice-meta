// kokoro-js declares its types only under package "exports", which the CommonJS build cannot read.
// The adapter types the few calls it makes itself.
declare module 'kokoro-js';
