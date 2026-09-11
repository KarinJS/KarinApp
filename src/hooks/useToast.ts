import {useCallback, useEffect, useRef, useState} from 'react';

const NOTICE_DURATION_MS = 2400;

export function useToast() {
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string, durationMs: number = NOTICE_DURATION_MS) => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    setNotice(message);
    timer.current = setTimeout(() => {
      setNotice(current => (current === message ? '' : current));
      timer.current = null;
    }, durationMs);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  return {notice, showNotice};
}
