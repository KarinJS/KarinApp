import {useEffect, useState} from 'react';
import {karinService} from '../services/karinService';

const POLL_INTERVAL_MS = 1_000;

/**
 * Karin 进程真实状态：运行标记、运行秒数、内存占用（字节）。
 * 仅在容器运行时轮询探测；进程被杀或崩溃时通过 subscribeExit 即时同步。
 */
export function useKarinRuntime(containerRunning: boolean) {
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [memoryBytes, setMemoryBytes] = useState(0);

  useEffect(() => {
    if (!containerRunning) {
      setRunning(false);
      setSeconds(0);
      setMemoryBytes(0);
      return;
    }
    let cancelled = false;
    let probing = false;
    const refresh = () => {
      if (probing) return;
      probing = true;
      karinService.probe().then(result => {
        if (cancelled) return;
        if (result.ok === false) return;
        setRunning(result.running);
        setMemoryBytes(result.memoryBytes);
        if (!result.running) setSeconds(0);
      }).finally(() => { probing = false; });
    };
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [containerRunning]);

  useEffect(() => karinService.subscribeExit(() => setRunning(false)), []);

  useEffect(() => {
    if (!running) return;
    const tick = () => {
      const startedAt = karinService.getStartedAt();
      if (startedAt !== null) setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running]);

  return {running, seconds, memoryBytes};
}
