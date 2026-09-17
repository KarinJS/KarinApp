import {startLogTail} from '../src/services/karinLogFileService';
import {prootController} from '../src/services/prootController';

jest.mock('../src/services/prootController', () => ({
  prootController: {
    subscribe: jest.fn(),
    execute: jest.fn(),
    kill: jest.fn(),
  },
}));

const controller = jest.mocked(prootController);
type CommandListener = Parameters<typeof prootController.subscribe>[0];

let listener: CommandListener;
const remove = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  controller.subscribe.mockImplementation(callback => {
    listener = callback;
    return {remove};
  });
  controller.execute.mockResolvedValue('');
  controller.kill.mockResolvedValue('');
});

test('shows replayed and new log lines before the tail process exits', () => {
  const onLine = jest.fn();
  const stop = startLogTail('2026-09-17', onLine);
  const commandId = controller.execute.mock.calls[0][1]!;
  const replay = '[17:00:00.000][INFO] already on disk';
  const appended = '[17:01:00.000][INFO] just appended';

  // karin-ipc sends each line without its trailing newline; tail -F stays alive.
  listener({commandId, stream: 'stdout', data: replay});
  expect(onLine.mock.calls).toEqual([[replay]]);

  listener({commandId, stream: 'stdout', data: appended});
  expect(onLine.mock.calls).toEqual([[replay], [appended]]);

  listener({commandId, stream: 'exit', data: '', exitCode: 143});
  expect(onLine.mock.calls).toEqual([[replay], [appended]]);
  stop();
});

test('ignores other commands and stderr while preserving separate output lines', () => {
  const onLine = jest.fn();
  const stop = startLogTail('2026-09-17', onLine);
  const commandId = controller.execute.mock.calls[0][1]!;

  listener({commandId: 'karin', stream: 'stdout', data: 'unrelated output'});
  listener({commandId, stream: 'stderr', data: 'tail diagnostic'});
  expect(onLine).not.toHaveBeenCalled();

  listener({commandId, stream: 'stdout', data: 'first line\n  continuation'});
  expect(onLine.mock.calls).toEqual([['first line'], ['  continuation']]);
  stop();
});

test('unsubscribes and stops only its own tail when leaving the log view', () => {
  const stop = startLogTail('2026-09-17', jest.fn());
  const commandId = controller.execute.mock.calls[0][1]!;

  stop();

  expect(remove).toHaveBeenCalledTimes(1);
  expect(controller.kill.mock.calls).toEqual([[commandId]]);
});
