const {test} = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const source = path.join(__dirname, '../server/DocService/sources/embeddedConverter.js');

// Load the real embedded converter with its server dependencies stubbed out (no npm install needed).
async function withConverter(maxProcessCount, check) {
  const queues = [];
  class FakeQueue {
    constructor() {
      queues.push(this);
    }
    initPromise(...flags) {
      this.flags = flags;
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  const stubs = {
    config: {get: () => maxProcessCount},
    '../../Common/sources/runtime/profile': {isMemoryRuntime: () => true},
    '../../Common/sources/operationContext': {global: {logger: {warn() {}}}},
    '../../Common/sources/taskqueueMemory': FakeQueue,
    '../../FileConverter/sources/converter': {createRunner: queue => (queue.runner = true), simulateErrorResponse() {}}
  };
  const load = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === source && Object.hasOwn(stubs, request)) return stubs[request];
    return load.apply(this, arguments);
  };
  delete require.cache[source];
  try {
    await check(require(source), queues);
  } finally {
    Module._load = load;
    delete require.cache[source];
  }
}

const cpus = os.availableParallelism?.() || os.cpus().length;

test('Embedded converter runs one subscriber per CPU, so conversions do not queue behind each other', async () => {
  await withConverter(1, async (converter, queues) => {
    await converter.start();
    assert.equal(queues.length, cpus);
    for (const queue of queues) {
      assert.equal(queue.runner, true);
      assert.deepEqual(queue.flags, [true, true, true, false, false, false]);
    }
    assert.equal(converter.isStarted(), true);
    await converter.stop();
    assert.equal(queues.every(queue => queue.closed), true);
    assert.equal(converter.isStarted(), false);
  });
});

test('maxprocesscount scales subscribers per CPU and never drops below one', async () => {
  await withConverter(2, async (converter, queues) => {
    await converter.start();
    assert.equal(queues.length, cpus * 2);
    await converter.stop();
  });
  await withConverter(0, async (converter, queues) => {
    await converter.start();
    assert.equal(queues.length, 1);
    await converter.stop();
  });
});
