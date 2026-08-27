import {useEffect, useState} from 'react';

/** Karin 进程运行时计时：运行中每秒递增。 */
export function useKarinRuntime() {
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => setSeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  return {running, setRunning, seconds, setSeconds};
}
